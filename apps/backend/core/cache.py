"""
Translation Cache Manager
=========================

File-based caching system for translated content to avoid redundant Claude API calls.
Uses stdlib only (pathlib and json) for maximum compatibility.

Cache Structure:
    .auto-claude/translations/
        {content_type}/
            {content_id}/
                {language}.json      # Translated content + metadata
                original.json        # Original content for rollback

Each cached translation includes:
    - translated_content: The translated JSON content
    - original_content: The original content for rollback
    - metadata:
        - language: Target language code
        - model: Claude model used for translation
        - timestamp: ISO 8601 timestamp of translation
        - content_hash: SHA256 hash of original content for invalidation

Usage:
    from core.cache import TranslationCache

    cache = TranslationCache()

    # Check cache
    cached = cache.get("roadmap", "feature-001", "pt-BR")
    if cached:
        return cached["translated_content"]

    # Store translation
    cache.set("roadmap", "feature-001", "pt-BR", translated_data, original_data, metadata)

    # Invalidate cache when original content changes
    cache.invalidate("roadmap", "feature-001")
"""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class TranslationCache:
    """File-based cache for translated content."""

    def __init__(self, cache_dir: str = ".auto-claude/translations"):
        """
        Initialize the translation cache.

        Args:
            cache_dir: Root directory for cache storage (relative to project root)
        """
        self.cache_dir = Path(cache_dir)

    def get(self, content_type: str, content_id: str, language: str) -> dict[str, Any] | None:
        """
        Retrieve cached translation if available.

        Args:
            content_type: Type of content (roadmap, ideas, changelog, specs)
            content_id: Unique identifier for the content
            language: Target language code (pt-BR, es, de, fr)

        Returns:
            Dict containing translated_content, original_content, and metadata if cached,
            None if not found or cache is invalid
        """
        cache_file = self._get_cache_file(content_type, content_id, language)

        if not cache_file.exists():
            return None

        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            # Cache corrupted or unreadable - treat as cache miss
            return None

    def set(
        self,
        content_type: str,
        content_id: str,
        language: str,
        translated_content: dict[str, Any],
        original_content: dict[str, Any],
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """
        Store translated content in cache.

        Args:
            content_type: Type of content (roadmap, ideas, changelog, specs)
            content_id: Unique identifier for the content
            language: Target language code (pt-BR, es, de, fr)
            translated_content: The translated JSON content
            original_content: The original content for rollback
            metadata: Optional metadata (model, timestamp, cost)
        """
        cache_file = self._get_cache_file(content_type, content_id, language)

        # Ensure cache directory exists
        cache_file.parent.mkdir(parents=True, exist_ok=True)

        # Compute content hash for cache invalidation
        content_hash = self._compute_hash(original_content)

        # Build cache entry with metadata
        cache_entry = {
            "translated_content": translated_content,
            "original_content": original_content,
            "metadata": {
                "language": language,
                "content_type": content_type,
                "content_id": content_id,
                "content_hash": content_hash,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                **(metadata or {}),
            },
        }

        # Write cache file
        try:
            cache_file.write_text(
                json.dumps(cache_entry, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
        except OSError as e:
            # Cache write failed - log but don't raise (cache is optional)
            pass

    def invalidate(self, content_type: str, content_id: str, language: str | None = None) -> None:
        """
        Invalidate cached translations for content.

        Args:
            content_type: Type of content (roadmap, ideas, changelog, specs)
            content_id: Unique identifier for the content
            language: Optional specific language to invalidate (if None, invalidates all)
        """
        if language:
            # Invalidate specific language
            cache_file = self._get_cache_file(content_type, content_id, language)
            if cache_file.exists():
                try:
                    cache_file.unlink()
                except OSError:
                    pass
        else:
            # Invalidate all languages for this content
            content_dir = self.cache_dir / content_type / content_id
            if content_dir.exists():
                try:
                    # Remove all language files
                    for cache_file in content_dir.glob("*.json"):
                        cache_file.unlink()
                    # Remove directory if empty
                    if not any(content_dir.iterdir()):
                        content_dir.rmdir()
                except OSError:
                    pass

    def is_valid(self, content_type: str, content_id: str, language: str, current_content: dict[str, Any]) -> bool:
        """
        Check if cached translation is still valid for current content.

        Args:
            content_type: Type of content (roadmap, ideas, changelog, specs)
            content_id: Unique identifier for the content
            language: Target language code
            current_content: Current version of the content to validate against

        Returns:
            True if cache exists and matches current content hash, False otherwise
        """
        cached = self.get(content_type, content_id, language)
        if not cached:
            return False

        current_hash = self._compute_hash(current_content)
        cached_hash = cached.get("metadata", {}).get("content_hash", "")

        return current_hash == cached_hash

    def _get_cache_file(self, content_type: str, content_id: str, language: str) -> Path:
        """
        Get the cache file path for a translation.

        Args:
            content_type: Type of content (roadmap, ideas, changelog, specs)
            content_id: Unique identifier for the content
            language: Target language code

        Returns:
            Path to the cache file
        """
        return self.cache_dir / content_type / content_id / f"{language}.json"

    def _compute_hash(self, content: dict[str, Any]) -> str:
        """
        Compute SHA256 hash of content for cache invalidation.

        Args:
            content: Content dictionary to hash

        Returns:
            Hexadecimal SHA256 hash string
        """
        # Serialize content to deterministic JSON (sorted keys)
        content_json = json.dumps(content, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(content_json.encode("utf-8")).hexdigest()
