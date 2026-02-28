import { create } from 'zustand';
import type {
  ContentTranslationState,
  SupportedLanguage,
  TargetLanguage,
  TranslatableContentType,
  TranslationDataMap,
  TranslationOptions,
  TranslationProgress,
  TranslationResponse,
  TranslationStateMap,
  TranslationStats
} from '../../shared/types/translation';

/**
 * Generate unique key for translation state map
 * Format: "{contentType}:{contentId}"
 */
function getTranslationKey(contentType: TranslatableContentType, contentId: string): string {
  return `${contentType}:${contentId}`;
}

/**
 * Generate unique key for translation data map (includes language)
 * Format: "{contentType}:{contentId}:{language}"
 */
function getTranslationDataKey(
  contentType: TranslatableContentType,
  contentId: string,
  language: SupportedLanguage
): string {
  return `${contentType}:${contentId}:${language}`;
}

interface TranslationState {
  // Data
  translationStates: TranslationStateMap; // Tracks translation state per content
  translationData: TranslationDataMap; // Stores actual translated content
  globalProgress: TranslationProgress | null; // Current operation progress
  stats: TranslationStats; // Translation statistics

  // Actions
  initializeContent: (contentType: TranslatableContentType, contentId: string) => void;
  translateContent: (
    contentType: TranslatableContentType,
    contentId: string,
    content: Record<string, unknown>,
    targetLanguage: TargetLanguage,
    options?: TranslationOptions
  ) => Promise<void>;
  revertTranslation: (contentType: TranslatableContentType, contentId: string) => void;
  setCurrentLanguage: (
    contentType: TranslatableContentType,
    contentId: string,
    language: SupportedLanguage
  ) => void;
  getTranslatedContent: (
    contentType: TranslatableContentType,
    contentId: string,
    language?: SupportedLanguage
  ) => Record<string, unknown> | null;
  getCurrentLanguage: (contentType: TranslatableContentType, contentId: string) => SupportedLanguage;
  isContentTranslating: (contentType: TranslatableContentType, contentId: string) => boolean;
  getAvailableTranslations: (
    contentType: TranslatableContentType,
    contentId: string
  ) => TargetLanguage[];
  clearTranslations: (contentType: TranslatableContentType, contentId: string) => void;
  clearAllTranslations: () => void;
  updateStats: (language: TargetLanguage, contentType: TranslatableContentType, cached: boolean) => void;
}

const initialStats: TranslationStats = {
  totalTranslations: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
  avgResponseTime: 0,
  byLanguage: { 'pt-BR': 0, es: 0, de: 0, fr: 0 },
  byContentType: { roadmap: 0, idea: 0, changelog: 0, spec: 0 }
};

export const useTranslationStore = create<TranslationState>((set, get) => ({
    // Initial state
    translationStates: new Map(),
    translationData: new Map(),
    globalProgress: null,
    stats: initialStats,

    // Initialize content translation state if not exists
    initializeContent: (contentType: TranslatableContentType, contentId: string): void => {
      const key = getTranslationKey(contentType, contentId);
      const existing = get().translationStates.get(key);

      if (!existing) {
        set((state: TranslationState) => {
          const newStates = new Map(state.translationStates);
          newStates.set(key, {
            contentId,
            contentType,
            currentLanguage: 'en',
            originalLanguage: 'en',
            availableTranslations: new Set(),
            translating: false
          });
          return { translationStates: newStates };
        });
      }
    },

    // Translate content to target language
    translateContent: async (
      contentType: TranslatableContentType,
      contentId: string,
      content: Record<string, unknown>,
      targetLanguage: TargetLanguage,
      options?: TranslationOptions
    ): Promise<void> => {
      const key = getTranslationKey(contentType, contentId);
      const dataKey = getTranslationDataKey(contentType, contentId, targetLanguage);

      // Initialize content state if needed
      get().initializeContent(contentType, contentId);

      // Set translating state
      set((state: TranslationState) => {
        const newStates = new Map(state.translationStates);
        const contentState = newStates.get(key);
        if (contentState) {
          newStates.set(key, { ...contentState, translating: true, error: undefined });
        }
        return {
          translationStates: newStates,
          globalProgress: { status: 'translating', message: 'Translating content...' }
        };
      });

      try {
        // Call IPC handler to translate content via backend
        // Note: window.electronAPI.translateContent will be added in subtask-2-3
        const result = await (window as any).electronAPI.translateContent({
          request: {
            contentType,
            contentId,
            content,
            targetLanguage
          },
          options
        });

        if (!result.success || !result.data) {
          throw new Error(result.error?.message || 'Translation failed');
        }

        const translationResponse: TranslationResponse = result.data;

        // Store translated content
        set((state: TranslationState) => {
          const newStates = new Map(state.translationStates);
          const newData = new Map(state.translationData);
          const contentState = newStates.get(key);

          if (contentState) {
            const newAvailableTranslations = new Set(contentState.availableTranslations);
            newAvailableTranslations.add(targetLanguage);

            newStates.set(key, {
              ...contentState,
              currentLanguage: targetLanguage,
              availableTranslations: newAvailableTranslations,
              translating: false,
              error: undefined
            });
          }

          // Store original content
          const originalKey = getTranslationDataKey(contentType, contentId, 'en');
          newData.set(originalKey, translationResponse.originalContent);

          // Store translated content
          newData.set(dataKey, translationResponse.translatedContent);

          return {
            translationStates: newStates,
            translationData: newData,
            globalProgress: { status: 'success', message: 'Translation complete' }
          };
        });

        // Update stats
        get().updateStats(
          targetLanguage,
          contentType,
          translationResponse.metadata.cached || false
        );

        // Clear progress after short delay
        setTimeout(() => {
          set({ globalProgress: null });
        }, 2000);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Set error state
        set((state: TranslationState) => {
          const newStates = new Map(state.translationStates);
          const contentState = newStates.get(key);
          if (contentState) {
            newStates.set(key, {
              ...contentState,
              translating: false,
              error: errorMessage
            });
          }
          return {
            translationStates: newStates,
            globalProgress: { status: 'error', message: errorMessage, error: errorMessage },
            stats: { ...state.stats, errors: state.stats.errors + 1 }
          };
        });

        // Clear progress after longer delay for errors
        setTimeout(() => {
          set({ globalProgress: null });
        }, 5000);

        throw error;
      }
    },

    // Revert to original language
    revertTranslation: (contentType: TranslatableContentType, contentId: string): void => {
      const key = getTranslationKey(contentType, contentId);

      set((state: TranslationState) => {
        const newStates = new Map(state.translationStates);
        const contentState = newStates.get(key);

        if (contentState) {
          newStates.set(key, {
            ...contentState,
            currentLanguage: 'en',
            error: undefined
          });
        }

        return { translationStates: newStates };
      });
    },

    // Set current display language for content
    setCurrentLanguage: (
      contentType: TranslatableContentType,
      contentId: string,
      language: SupportedLanguage
    ): void => {
      const key = getTranslationKey(contentType, contentId);

      set((state: TranslationState) => {
        const newStates = new Map(state.translationStates);
        const contentState = newStates.get(key);

        if (contentState) {
          // Only allow switching to languages that have been translated or original
          if (
            language === 'en' ||
            contentState.availableTranslations.has(language as TargetLanguage)
          ) {
            newStates.set(key, {
              ...contentState,
              currentLanguage: language,
              error: undefined
            });
          }
        }

        return { translationStates: newStates };
      });
    },

    // Get translated content for specific language
    getTranslatedContent: (
      contentType: TranslatableContentType,
      contentId: string,
      language?: SupportedLanguage
    ): Record<string, unknown> | null => {
      const state = get();
      const key = getTranslationKey(contentType, contentId);
      const contentState = state.translationStates.get(key);

      // Use current language if not specified
      const targetLanguage = language || contentState?.currentLanguage || 'en';

      const dataKey = getTranslationDataKey(contentType, contentId, targetLanguage);
      return state.translationData.get(dataKey) || null;
    },

    // Get current language for content
    getCurrentLanguage: (contentType: TranslatableContentType, contentId: string): SupportedLanguage => {
      const key = getTranslationKey(contentType, contentId);
      const contentState = get().translationStates.get(key);
      return contentState?.currentLanguage || 'en';
    },

    // Check if content is currently being translated
    isContentTranslating: (contentType: TranslatableContentType, contentId: string): boolean => {
      const key = getTranslationKey(contentType, contentId);
      const contentState = get().translationStates.get(key);
      return contentState?.translating || false;
    },

    // Get list of available translations for content
    getAvailableTranslations: (
      contentType: TranslatableContentType,
      contentId: string
    ): TargetLanguage[] => {
      const key = getTranslationKey(contentType, contentId);
      const contentState = get().translationStates.get(key);
      return contentState ? Array.from(contentState.availableTranslations) : [];
    },

    // Clear all translations for specific content
    clearTranslations: (contentType: TranslatableContentType, contentId: string): void => {
      const key = getTranslationKey(contentType, contentId);

      set((state: TranslationState) => {
        const newStates = new Map(state.translationStates);
        const newData = new Map(state.translationData);

        // Reset content state
        const contentState = newStates.get(key);
        if (contentState) {
          newStates.set(key, {
            ...contentState,
            currentLanguage: 'en',
            availableTranslations: new Set(),
            error: undefined
          });
        }

        // Remove translation data for this content
        const keysToDelete: string[] = [];
        for (const [dataKey] of newData) {
          if (dataKey.startsWith(`${contentType}:${contentId}:`)) {
            keysToDelete.push(dataKey);
          }
        }
        for (const dataKey of keysToDelete) {
          newData.delete(dataKey);
        }

        return { translationStates: newStates, translationData: newData };
      });
    },

    // Clear all translations (useful for cleanup)
    clearAllTranslations: (): void => {
      set({
        translationStates: new Map(),
        translationData: new Map(),
        globalProgress: null,
        stats: initialStats
      });
    },

    // Update translation statistics
    updateStats: (
      language: TargetLanguage,
      contentType: TranslatableContentType,
      cached: boolean
    ): void => {
      set((state: TranslationState) => {
        const newStats = { ...state.stats };
        newStats.totalTranslations += 1;

        if (cached) {
          newStats.cacheHits += 1;
        } else {
          newStats.cacheMisses += 1;
        }

        newStats.byLanguage = { ...newStats.byLanguage };
        newStats.byLanguage[language] = (newStats.byLanguage[language] || 0) + 1;

        newStats.byContentType = { ...newStats.byContentType };
        newStats.byContentType[contentType] = (newStats.byContentType[contentType] || 0) + 1;

        return { stats: newStats };
      });
    }
  })
);
