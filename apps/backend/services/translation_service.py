#!/usr/bin/env python3
"""
Translation Service
===================

Service for translating AI-generated content using Claude API.

Uses create_client() from core.client for security and messages.parse() for
structured JSON output with Pydantic schema validation. Integrates with
file-based caching to minimize redundant API calls.

Supports translating:
- Roadmap features
- Ideas (code improvements, UI/UX, security, etc.)
- Changelog entries
- Spec documents

Usage:
    from services.translation_service import TranslationService

    service = TranslationService()

    # Translate roadmap feature
    result = service.translate(
        content={"title": "User Authentication", "description": "..."},
        target_language="pt-BR",
        content_type="roadmap",
        content_id="feature-001"
    )

    # Revert to original content
    original = service.revert("roadmap", "feature-001", "pt-BR")
"""

import logging
import time
from datetime import datetime, timezone
from typing import Any, Literal

from core.cache import TranslationCache
from core.client import create_client
from schemas.translation import (
    ChangelogTranslation,
    IdeaTranslation,
    RoadmapTranslation,
    SpecTranslation,
    TranslationRequest,
    TranslationResponse,
)

logger = logging.getLogger(__name__)

# Content type to Pydantic schema mapping
SCHEMA_MAP = {
    "roadmap": RoadmapTranslation,
    "idea": IdeaTranslation,
    "changelog": ChangelogTranslation,
    "spec": SpecTranslation,
}

# Language code to full name mapping
LANGUAGE_NAMES = {
    "pt-BR": "Portuguese (Brazil)",
    "es": "Spanish",
    "de": "German",
    "fr": "French",
    "en": "English",
}


class TranslationError(Exception):
    """Base exception for translation service errors."""

    pass


class RateLimitError(TranslationError):
    """Raised when Claude API rate limit is exceeded."""

    def __init__(self, retry_after: int | None = None):
        """
        Initialize rate limit error.

        Args:
            retry_after: Seconds to wait before retrying (from API response)
        """
        self.retry_after = retry_after
        super().__init__(
            f"Rate limit exceeded. Retry after {retry_after}s"
            if retry_after
            else "Rate limit exceeded"
        )


class TranslationService:
    """Service for translating AI-generated content using Claude API."""

    def __init__(self, cache_dir: str = ".auto-claude/translations"):
        """
        Initialize the translation service.

        Args:
            cache_dir: Directory for translation cache (default: .auto-claude/translations)
        """
        self.cache = TranslationCache(cache_dir)
        self.client = None  # Lazy initialization on first use

    def _get_client(self):
        """
        Get or create Claude SDK client.

        Lazily initializes the client on first use to avoid unnecessary
        authentication overhead during service instantiation.

        Returns:
            Configured Claude SDK client
        """
        if self.client is None:
            self.client = create_client()
        return self.client

    def translate(
        self,
        content: dict[str, Any],
        target_language: str,
        content_type: Literal["roadmap", "idea", "changelog", "spec"],
        content_id: str,
        force_refresh: bool = False,
    ) -> TranslationResponse:
        """
        Translate content to target language.

        Checks cache first. If not cached or force_refresh=True, calls Claude API
        with structured JSON schema validation.

        Args:
            content: Original content to translate (structured JSON)
            target_language: Target language code (pt-BR, es, de, fr)
            content_type: Type of content (roadmap, idea, changelog, spec)
            content_id: Unique identifier for the content
            force_refresh: Force fresh translation even if cached

        Returns:
            TranslationResponse with translated content and metadata

        Raises:
            TranslationError: If translation fails
            RateLimitError: If rate limit is exceeded
            ValueError: If content_type is invalid or target_language is unsupported
        """
        # Validate inputs
        if content_type not in SCHEMA_MAP:
            raise ValueError(
                f"Invalid content_type: {content_type}. "
                f"Must be one of: {', '.join(SCHEMA_MAP.keys())}"
            )

        if target_language not in LANGUAGE_NAMES:
            raise ValueError(
                f"Unsupported target_language: {target_language}. "
                f"Supported: {', '.join(LANGUAGE_NAMES.keys())}"
            )

        # Check cache (skip if force_refresh)
        if not force_refresh:
            cached = self.cache.get(content_type, content_id, target_language)
            if cached and self.cache.is_valid(
                content_type, content_id, target_language, content
            ):
                logger.info(
                    f"Cache HIT for {content_type} {content_id} ({target_language})"
                )
                # Return cached translation in TranslationResponse format
                metadata = cached.get("metadata", {})
                return TranslationResponse(
                    translated_content=cached["translated_content"],
                    language=target_language,
                    model=metadata.get("model", "unknown"),
                    timestamp=metadata.get("timestamp", datetime.now(timezone.utc).isoformat()),
                    content_type=content_type,
                )

        # Cache miss or force refresh - call Claude API
        logger.info(
            f"Cache MISS for {content_type} {content_id} ({target_language}) - calling Claude API"
        )

        try:
            translated_content = self._call_claude_api(
                content, target_language, content_type
            )
        except RateLimitError:
            # Re-raise rate limit errors for exponential backoff handling
            raise
        except Exception as e:
            logger.error(f"Translation failed: {e}", exc_info=True)
            raise TranslationError(f"Translation failed: {str(e)}") from e

        # Build response with metadata
        model_used = "claude-sonnet-4-5"  # Current default model
        response = TranslationResponse(
            translated_content=translated_content,
            language=target_language,
            model=model_used,
            timestamp=datetime.now(timezone.utc).isoformat(),
            content_type=content_type,
        )

        # Store in cache
        try:
            self.cache.set(
                content_type,
                content_id,
                target_language,
                translated_content,
                content,
                metadata={
                    "model": model_used,
                },
            )
            logger.info(
                f"Cached translation for {content_type} {content_id} ({target_language})"
            )
        except Exception as e:
            # Cache write failures are non-fatal
            logger.warning(f"Failed to cache translation: {e}")

        return response

    def _call_claude_api(
        self,
        content: dict[str, Any],
        target_language: str,
        content_type: str,
    ) -> dict[str, Any]:
        """
        Call Claude API to translate content.

        Uses messages.parse() with Pydantic schema for structured JSON output.

        Args:
            content: Original content to translate
            target_language: Target language code
            content_type: Type of content (roadmap, idea, changelog, spec)

        Returns:
            Translated content as dict

        Raises:
            RateLimitError: If rate limit exceeded
            TranslationError: If API call fails
        """
        # Get Pydantic schema for content type
        schema_class = SCHEMA_MAP[content_type]
        language_name = LANGUAGE_NAMES[target_language]

        # Build translation prompt
        prompt = self._build_translation_prompt(content, language_name, content_type)

        # Call Claude API with structured output
        client = self._get_client()

        try:
            response = client.messages.parse(
                model="claude-sonnet-4-5",
                max_tokens=4096,
                messages=[
                    {
                        "role": "user",
                        "content": prompt,
                    }
                ],
                output_format=schema_class,  # Note: parameter is 'output_format', not 'response_format'
            )

            # Extract parsed output
            if not hasattr(response, "parsed_output"):
                raise TranslationError(
                    "API response missing parsed_output attribute"
                )

            translated = response.parsed_output

            # Convert Pydantic model to dict
            if hasattr(translated, "model_dump"):
                return translated.model_dump()
            elif hasattr(translated, "dict"):
                return translated.dict()
            else:
                raise TranslationError(
                    f"Unable to convert Pydantic model to dict: {type(translated)}"
                )

        except Exception as e:
            # Check for rate limit errors
            error_msg = str(e).lower()
            if "rate" in error_msg and "limit" in error_msg:
                # Try to extract retry_after from error message
                retry_after = None
                if "retry after" in error_msg:
                    try:
                        # Extract number from "retry after X seconds"
                        parts = error_msg.split("retry after")
                        if len(parts) > 1:
                            num_str = "".join(
                                c for c in parts[1].split("s")[0] if c.isdigit()
                            )
                            if num_str:
                                retry_after = int(num_str)
                    except (ValueError, IndexError):
                        pass
                raise RateLimitError(retry_after) from e

            # Re-raise other errors as TranslationError
            raise TranslationError(f"Claude API call failed: {str(e)}") from e

    def _build_translation_prompt(
        self, content: dict[str, Any], target_language: str, content_type: str
    ) -> str:
        """
        Build translation prompt for Claude API.

        Args:
            content: Original content to translate
            target_language: Target language name (e.g., "Portuguese (Brazil)")
            content_type: Type of content (roadmap, idea, changelog, spec)

        Returns:
            Translation prompt as string
        """
        content_type_labels = {
            "roadmap": "roadmap feature",
            "idea": "idea",
            "changelog": "changelog entry",
            "spec": "specification document",
        }

        label = content_type_labels.get(content_type, content_type)

        # Build content representation for prompt
        import json

        content_json = json.dumps(content, indent=2, ensure_ascii=False)

        prompt = f"""Translate the following {label} content to {target_language}.

IMPORTANT REQUIREMENTS:
1. Preserve the exact JSON structure - only translate text values, NOT keys
2. Maintain markdown formatting in translated text
3. Keep code blocks, code examples, and technical terms in their original language
4. Preserve all special characters, line breaks, and formatting
5. Translate natural language text while keeping technical terms recognizable
6. Do NOT translate: version numbers, dates, URLs, file paths, variable names, function names

Original content:
{content_json}

Translate all text fields to {target_language} while preserving the structure."""

        return prompt

    def revert(
        self, content_type: str, content_id: str, language: str
    ) -> dict[str, Any] | None:
        """
        Revert to original content (undo translation).

        Retrieves the original content from cache.

        Args:
            content_type: Type of content (roadmap, idea, changelog, spec)
            content_id: Unique identifier for the content
            language: Language to revert from

        Returns:
            Original content dict if available, None if not cached
        """
        cached = self.cache.get(content_type, content_id, language)
        if cached:
            logger.info(
                f"Reverting {content_type} {content_id} from {language} to original"
            )
            return cached.get("original_content")
        return None

    def invalidate_cache(
        self, content_type: str, content_id: str, language: str | None = None
    ) -> None:
        """
        Invalidate cached translations for content.

        Useful when original content has been modified.

        Args:
            content_type: Type of content (roadmap, idea, changelog, spec)
            content_id: Unique identifier for the content
            language: Optional specific language to invalidate (if None, invalidates all)
        """
        self.cache.invalidate(content_type, content_id, language)
        logger.info(
            f"Invalidated cache for {content_type} {content_id}"
            + (f" ({language})" if language else " (all languages)")
        )


def translate_with_retry(
    service: TranslationService,
    content: dict[str, Any],
    target_language: str,
    content_type: Literal["roadmap", "idea", "changelog", "spec"],
    content_id: str,
    max_retries: int = 3,
) -> TranslationResponse:
    """
    Translate content with exponential backoff retry on rate limits.

    Utility function for handling rate limit errors with automatic retry.

    Args:
        service: TranslationService instance
        content: Original content to translate
        target_language: Target language code
        content_type: Type of content
        content_id: Unique identifier for the content
        max_retries: Maximum number of retry attempts (default: 3)

    Returns:
        TranslationResponse with translated content

    Raises:
        TranslationError: If translation fails after all retries
        RateLimitError: If rate limit persists after all retries
    """
    backoff_delays = [1, 2, 4, 8]  # Exponential backoff: 1s, 2s, 4s, 8s

    for attempt in range(max_retries + 1):
        try:
            return service.translate(
                content=content,
                target_language=target_language,
                content_type=content_type,
                content_id=content_id,
            )
        except RateLimitError as e:
            if attempt >= max_retries:
                logger.error(
                    f"Rate limit exceeded after {max_retries} retries - giving up"
                )
                raise

            # Use API-provided retry_after if available, otherwise use exponential backoff
            delay = e.retry_after if e.retry_after else backoff_delays[attempt]
            logger.warning(
                f"Rate limit hit (attempt {attempt + 1}/{max_retries + 1}) - "
                f"retrying after {delay}s"
            )
            time.sleep(delay)

    # Should never reach here, but just in case
    raise TranslationError("Translation failed after all retries")
