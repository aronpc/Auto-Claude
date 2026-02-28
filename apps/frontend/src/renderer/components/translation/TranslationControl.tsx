/**
 * TranslationControl - Reusable component for translating AI-generated content
 *
 * Provides translation controls with language selection, translate/revert buttons,
 * loading states, and error display.
 *
 * Features:
 * - Language selector with supported target languages (pt-BR, es, de, fr)
 * - Translate button triggers translation via backend service
 * - Revert button restores original language
 * - Loading spinner during translation operations
 * - Error messages for failed translations
 * - Disabled state during translation to prevent duplicate requests
 *
 * Used in: Roadmap, Ideas, Changelog, Specs views
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Languages, Loader2, RotateCcw, AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { LanguageSelector } from './LanguageSelector';
import { useTranslationStore } from '../../stores/translation-store';
import type { TranslatableContentType, TargetLanguage } from '../../../shared/types/translation';

interface TranslationControlProps {
  /** Type of content being translated */
  contentType: TranslatableContentType;
  /** Unique identifier for the content */
  contentId: string;
  /** Original content to be translated */
  content: Record<string, unknown>;
  /** Optional callback when translation completes successfully */
  onTranslated?: (translatedContent: Record<string, unknown>) => void;
  /** Optional callback when translation is reverted */
  onReverted?: () => void;
  /** Whether to show controls in compact mode (smaller buttons) */
  compact?: boolean;
  /** Custom CSS class for container */
  className?: string;
}

/**
 * TranslationControl component
 *
 * Provides UI controls for translating AI-generated content to different languages.
 * Integrates with translation store for state management and IPC for backend communication.
 */
export function TranslationControl({
  contentType,
  contentId,
  content,
  onTranslated,
  onReverted,
  compact = false,
  className = ''
}: TranslationControlProps) {
  const { t } = useTranslation(['translation', 'common']);

  // Translation store actions and state
  const {
    initializeContent,
    translateContent,
    revertTranslation,
    getCurrentLanguage,
    isContentTranslating,
    getTranslatedContent,
    getAvailableTranslations
  } = useTranslationStore();

  // Local state for selected language
  const [selectedLanguage, setSelectedLanguage] = useState<TargetLanguage | ''>('');
  const [error, setError] = useState<string | null>(null);

  // Get current state from store
  const currentLanguage = getCurrentLanguage(contentType, contentId);
  const isTranslating = isContentTranslating(contentType, contentId);
  const availableTranslations = getAvailableTranslations(contentType, contentId);

  // Derived state
  const isTranslated = currentLanguage !== 'en';
  const hasError = error !== null;

  // Initialize content in store on mount
  useEffect(() => {
    initializeContent(contentType, contentId);
  }, [contentType, contentId, initializeContent]);

  // Auto-clear error after 5 seconds
  useEffect(() => {
    if (error) {
      const timeoutId = setTimeout(() => {
        setError(null);
      }, 5000);
      return () => clearTimeout(timeoutId);
    }
  }, [error]);

  /**
   * Handle translate button click
   */
  const handleTranslate = async () => {
    if (!selectedLanguage) {
      setError(t('translation:errors.noLanguageSelected'));
      return;
    }

    setError(null);

    try {
      await translateContent(contentType, contentId, content, selectedLanguage);

      // Get the translated content and notify parent
      const translatedContent = getTranslatedContent(contentType, contentId, selectedLanguage);
      if (translatedContent && onTranslated) {
        onTranslated(translatedContent);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('translation:errors.translationFailed');
      setError(errorMessage);
    }
  };

  /**
   * Handle revert button click
   */
  const handleRevert = () => {
    revertTranslation(contentType, contentId);
    setSelectedLanguage('');
    setError(null);

    if (onReverted) {
      onReverted();
    }
  };

  /**
   * Handle language selection change
   */
  const handleLanguageChange = (language: TargetLanguage) => {
    setSelectedLanguage(language);
    setError(null);

    // If this language is already available, switch to it immediately
    if (availableTranslations.includes(language)) {
      const translatedContent = getTranslatedContent(contentType, contentId, language);
      if (translatedContent && onTranslated) {
        onTranslated(translatedContent);
      }
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* Translation Controls Row */}
      <div className="flex items-center gap-2">
        {/* Language Selector */}
        {!isTranslated && (
          <LanguageSelector
            value={selectedLanguage}
            onChange={handleLanguageChange}
            disabled={isTranslating}
            showLabel={false}
            className="flex-1"
          />
        )}

        {/* Current Language Badge (when translated) */}
        {isTranslated && (
          <div className="flex items-center gap-2 px-3 py-1 bg-accent rounded-md text-sm">
            <Languages className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">
              {t(`translation:languages.${currentLanguage}` as `translation:languages.${TargetLanguage}`)}
            </span>
          </div>
        )}

        {/* Translate Button */}
        {!isTranslated && (
          <Button
            onClick={handleTranslate}
            disabled={!selectedLanguage || isTranslating}
            size={compact ? 'sm' : 'default'}
            variant="default"
            className="shrink-0"
            aria-label={t('translation:accessibility.translateButtonAriaLabel')}
          >
            {isTranslating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('translation:status.translating')}
              </>
            ) : (
              <>
                <Languages className="h-4 w-4 mr-2" />
                {t('translation:actions.translate')}
              </>
            )}
          </Button>
        )}

        {/* Revert Button */}
        {isTranslated && (
          <Button
            onClick={handleRevert}
            disabled={isTranslating}
            size={compact ? 'sm' : 'default'}
            variant="outline"
            className="shrink-0"
            aria-label={t('translation:accessibility.revertButtonAriaLabel')}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {t('translation:actions.revert')}
          </Button>
        )}
      </div>

      {/* Error Message */}
      {hasError && (
        <div className="flex items-start gap-2 p-2 bg-destructive/10 border border-destructive/20 rounded-md text-sm text-destructive">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <p className="flex-1">{error}</p>
        </div>
      )}

      {/* Translation Status Info */}
      {isTranslated && !hasError && (
        <div className="text-xs text-muted-foreground">
          {t('translation:status.translated')}
        </div>
      )}
    </div>
  );
}
