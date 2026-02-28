/**
 * LanguageSelector - Dropdown component for selecting target translation language
 *
 * Provides a dropdown with supported translation languages (pt-BR, es, de, fr)
 * with language names displayed in the current UI language.
 *
 * Used in TranslationControl component for AI-generated content translation.
 */
import { useTranslation } from 'react-i18next';
import { Languages } from 'lucide-react';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import type { TargetLanguage, SupportedLanguage } from '../../../shared/types/translation';

interface LanguageSelectorProps {
  /** Currently selected language */
  value: TargetLanguage | '';
  /** Called when language selection changes */
  onChange: (language: TargetLanguage) => void;
  /** Whether the selector is disabled (e.g., during translation) */
  disabled?: boolean;
  /** Optional label text (defaults to translation key) */
  label?: string;
  /** Whether to show the label (default: true) */
  showLabel?: boolean;
  /** Custom placeholder text */
  placeholder?: string;
  /** Custom CSS class for container */
  className?: string;
}

/**
 * Supported target languages for translation
 * Excludes 'en' as it's the original language
 */
const SUPPORTED_LANGUAGES: TargetLanguage[] = ['pt-BR', 'es', 'de', 'fr'];

/**
 * LanguageSelector component
 *
 * A dropdown selector for choosing a target translation language.
 * Displays language names using i18n translations for proper localization.
 */
export function LanguageSelector({
  value,
  onChange,
  disabled = false,
  label,
  showLabel = true,
  placeholder,
  className
}: LanguageSelectorProps) {
  const { t } = useTranslation(['translation', 'common']);

  const defaultLabel = label || t('translation:controls.selectLanguage');
  const defaultPlaceholder = placeholder || t('translation:controls.selectLanguage');

  return (
    <div className={className}>
      {showLabel && (
        <Label htmlFor="language-selector" className="text-sm font-medium text-foreground">
          {defaultLabel}
        </Label>
      )}
      <Select
        value={value}
        onValueChange={(val) => onChange(val as TargetLanguage)}
        disabled={disabled}
      >
        <SelectTrigger
          id="language-selector"
          className="h-9"
          aria-label={t('translation:accessibility.languageSelectorAriaLabel')}
        >
          <SelectValue placeholder={defaultPlaceholder}>
            {value && (
              <div className="flex items-center gap-2">
                <Languages className="h-4 w-4" />
                <span>{t(`translation:languages.${value}` as `translation:languages.${SupportedLanguage}`)}</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LANGUAGES.map((lang) => (
            <SelectItem key={lang} value={lang}>
              <div className="flex items-center gap-2">
                <Languages className="h-4 w-4 shrink-0" />
                <div>
                  <span className="font-medium">
                    {t(`translation:languages.${lang}` as `translation:languages.${SupportedLanguage}`)}
                  </span>
                </div>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
