"""
Translation Schemas
===================

Pydantic models for translating AI-generated content types.
Used with Claude API's messages.parse() to guarantee JSON structure preservation.

All schemas are designed to preserve the original structure while translating
text fields into the target language.
"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


# =============================================================================
# Roadmap Feature Translation
# =============================================================================


class RoadmapTranslation(BaseModel):
    """
    Schema for translating roadmap feature content.

    Preserves the structure of roadmap features while translating text fields.
    Used with Claude API to ensure consistent JSON output.
    """

    title: str = Field(
        ...,
        description="Translated feature title",
    )
    description: str = Field(
        ...,
        description="Translated feature description",
    )
    rationale: str = Field(
        ...,
        description="Translated rationale explaining why this feature is important",
    )
    acceptance_criteria: list[str] = Field(
        default_factory=list,
        description="List of translated acceptance criteria",
    )
    user_stories: list[str] = Field(
        default_factory=list,
        description="List of translated user stories",
    )

    class Config:
        """Pydantic configuration."""

        json_schema_extra = {
            "example": {
                "title": "Autenticação de Usuário",
                "description": "Implementar sistema de autenticação de usuário com JWT",
                "rationale": "Os usuários precisam de contas seguras para acessar recursos protegidos",
                "acceptance_criteria": [
                    "Usuários podem se registrar com email e senha",
                    "Usuários podem fazer login e receber token JWT",
                    "Tokens expiram após 24 horas",
                ],
                "user_stories": [
                    "Como usuário, eu quero fazer login para acessar minha conta",
                    "Como usuário, eu quero me registrar para criar uma nova conta",
                ],
            }
        }


# =============================================================================
# Idea Translation
# =============================================================================


class IdeaTranslation(BaseModel):
    """
    Schema for translating ideation content.

    Preserves the structure of ideas (code improvements, UI/UX, security, etc.)
    while translating text fields. Handles all idea types with common fields.
    """

    title: str = Field(
        ...,
        description="Translated idea title",
    )
    description: str = Field(
        ...,
        description="Translated idea description",
    )
    rationale: str = Field(
        ...,
        description="Translated rationale explaining why this idea is valuable",
    )
    # Optional fields for type-specific content
    implementation_approach: Optional[str] = Field(
        None,
        description="Translated implementation approach (for code improvements)",
    )
    current_state: Optional[str] = Field(
        None,
        description="Translated current state description (for UI/UX and code quality)",
    )
    proposed_change: Optional[str] = Field(
        None,
        description="Translated proposed change (for UI/UX, documentation, code quality)",
    )
    user_benefit: Optional[str] = Field(
        None,
        description="Translated user benefit (for UI/UX improvements)",
    )
    proposed_content: Optional[str] = Field(
        None,
        description="Translated proposed documentation content (for documentation gaps)",
    )
    current_documentation: Optional[str] = Field(
        None,
        description="Translated current documentation state (for documentation gaps)",
    )
    current_risk: Optional[str] = Field(
        None,
        description="Translated current risk description (for security hardening)",
    )
    remediation: Optional[str] = Field(
        None,
        description="Translated remediation steps (for security hardening)",
    )
    expected_improvement: Optional[str] = Field(
        None,
        description="Translated expected improvement (for performance optimizations)",
    )
    implementation: Optional[str] = Field(
        None,
        description="Translated implementation details (for performance optimizations)",
    )
    tradeoffs: Optional[str] = Field(
        None,
        description="Translated tradeoffs (for performance optimizations)",
    )
    code_example: Optional[str] = Field(
        None,
        description="Translated code example (for code quality, preserve code syntax)",
    )
    best_practice: Optional[str] = Field(
        None,
        description="Translated best practice reference (for code quality)",
    )

    class Config:
        """Pydantic configuration."""

        json_schema_extra = {
            "example": {
                "title": "Adicionar cache para consultas de banco de dados",
                "description": "Implementar camada de cache Redis para consultas frequentes",
                "rationale": "Reduzir carga do banco de dados e melhorar tempo de resposta",
                "implementation_approach": "Usar biblioteca redis-py com TTL de 5 minutos",
            }
        }


# =============================================================================
# Changelog Entry Translation
# =============================================================================


class ChangelogTranslation(BaseModel):
    """
    Schema for translating changelog entry content.

    Preserves markdown formatting while translating changelog entries.
    Handles version-based changelog entries with categorized changes.
    """

    content: str = Field(
        ...,
        description="Translated changelog content in markdown format",
    )
    version: Optional[str] = Field(
        None,
        description="Version number (not translated)",
    )
    date: Optional[str] = Field(
        None,
        description="Release date (not translated)",
    )

    class Config:
        """Pydantic configuration."""

        json_schema_extra = {
            "example": {
                "version": "1.2.0",
                "date": "2024-02-28",
                "content": "## Adicionado\n- Novo sistema de autenticação\n- Suporte para tema escuro\n\n## Corrigido\n- Bug no formulário de login\n",
            }
        }


# =============================================================================
# Spec Document Translation
# =============================================================================


class SpecSection(BaseModel):
    """
    Schema for a single section in a spec document.

    Each section has a heading and content in markdown format.
    """

    heading: str = Field(
        ...,
        description="Translated section heading",
    )
    content: str = Field(
        ...,
        description="Translated section content in markdown format",
    )


class SpecTranslation(BaseModel):
    """
    Schema for translating spec document content.

    Preserves markdown structure while translating spec.md files.
    Organized by sections (Overview, Requirements, Patterns, etc.).
    """

    title: str = Field(
        ...,
        description="Translated spec title",
    )
    overview: str = Field(
        ...,
        description="Translated overview section",
    )
    workflow_type: Optional[str] = Field(
        None,
        description="Workflow type (not translated: feature, bugfix, refactor, etc.)",
    )
    workflow_rationale: Optional[str] = Field(
        None,
        description="Translated workflow rationale",
    )
    task_scope: Optional[str] = Field(
        None,
        description="Translated task scope section",
    )
    requirements: Optional[str] = Field(
        None,
        description="Translated requirements section",
    )
    patterns: Optional[str] = Field(
        None,
        description="Translated patterns to follow section",
    )
    implementation_notes: Optional[str] = Field(
        None,
        description="Translated implementation notes",
    )
    success_criteria: Optional[str] = Field(
        None,
        description="Translated success criteria section",
    )
    sections: list[SpecSection] = Field(
        default_factory=list,
        description="Additional translated sections",
    )

    class Config:
        """Pydantic configuration."""

        json_schema_extra = {
            "example": {
                "title": "Sistema de Autenticação de Usuário",
                "overview": "Construir um sistema de autenticação completo usando JWT...",
                "workflow_type": "feature",
                "workflow_rationale": "Esta é uma nova funcionalidade que introduz autenticação...",
                "requirements": "1. Registro de usuário\n2. Login\n3. Gerenciamento de tokens",
            }
        }


# =============================================================================
# Translation Request/Response Wrappers
# =============================================================================


class TranslationRequest(BaseModel):
    """
    Request schema for translation service.

    Used to validate incoming translation requests from IPC handlers.
    """

    content: dict[str, Any] = Field(
        ...,
        description="Original content to translate (structured JSON)",
    )
    target_language: str = Field(
        ...,
        description="Target language code (pt-BR, es, de, fr)",
    )
    content_type: Literal["roadmap", "idea", "changelog", "spec"] = Field(
        ...,
        description="Type of content being translated",
    )
    content_id: str = Field(
        ...,
        description="Unique identifier for the content (for caching)",
    )


class TranslationResponse(BaseModel):
    """
    Response schema for translation service.

    Contains translated content along with metadata for caching and auditing.
    """

    translated_content: dict[str, Any] = Field(
        ...,
        description="Translated content preserving original JSON structure",
    )
    language: str = Field(
        ...,
        description="Target language code",
    )
    model: str = Field(
        ...,
        description="Claude model used for translation",
    )
    timestamp: str = Field(
        ...,
        description="ISO timestamp of when translation was performed",
    )
    content_type: str = Field(
        ...,
        description="Type of content that was translated",
    )
