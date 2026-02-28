import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import type {
  IPCResult,
  TranslationRequest,
  TranslationResponse,
  TargetLanguage,
  TranslatableContentType,
  TranslationCacheEntry,
} from '../../shared/types';
import { projectStore } from '../project-store';
import { getConfiguredPythonPath, pythonEnvManager } from '../python-env-manager';
import { debugLog, debugError } from '../../shared/utils/debug-logger';

/**
 * Get the path to cached translation file
 */
function getCachedTranslationPath(
  projectPath: string,
  contentType: TranslatableContentType,
  contentId: string,
  language: TargetLanguage
): string {
  return path.join(
    projectPath,
    '.auto-claude',
    'translations',
    contentType,
    contentId,
    `${language}.json`
  );
}

/**
 * Load cached translation if available
 */
function loadCachedTranslation(
  projectPath: string,
  contentType: TranslatableContentType,
  contentId: string,
  language: TargetLanguage
): TranslationCacheEntry | null {
  const cachePath = getCachedTranslationPath(projectPath, contentType, contentId, language);

  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const cacheContent = readFileSync(cachePath, 'utf-8');
    const cacheEntry: TranslationCacheEntry = JSON.parse(cacheContent);
    return cacheEntry;
  } catch (error) {
    debugError('[Translation Handler] Failed to load cached translation:', error);
    return null;
  }
}

/**
 * Get list of available translations for content
 */
function getAvailableTranslations(
  projectPath: string,
  contentType: TranslatableContentType,
  contentId: string
): TargetLanguage[] {
  const translationsDir = path.join(
    projectPath,
    '.auto-claude',
    'translations',
    contentType,
    contentId
  );

  if (!existsSync(translationsDir)) {
    return [];
  }

  try {
    const fs = require('fs');
    const files = fs.readdirSync(translationsDir);

    // Extract language codes from .json files (e.g., "pt-BR.json" -> "pt-BR")
    const languages = files
      .filter((file: string) => file.endsWith('.json'))
      .map((file: string) => file.replace('.json', ''))
      .filter((lang: string) =>
        ['pt-BR', 'es', 'de', 'fr'].includes(lang)
      ) as TargetLanguage[];

    return languages;
  } catch (error) {
    debugError('[Translation Handler] Failed to read translations directory:', error);
    return [];
  }
}

/**
 * Call Python translation service via subprocess
 */
async function callTranslationService(
  projectPath: string,
  request: TranslationRequest
): Promise<TranslationResponse> {
  return new Promise((resolve, reject) => {
    const pythonExe = getConfiguredPythonPath();
    if (!pythonExe) {
      reject(new Error('Python environment not configured'));
      return;
    }

    // Path to translation service script
    const backendPath = path.join(projectPath, 'apps', 'backend');
    const scriptPath = path.join(backendPath, 'services', 'translation_service.py');

    if (!existsSync(scriptPath)) {
      reject(new Error('Translation service script not found'));
      return;
    }

    // Prepare request as JSON
    const requestJson = JSON.stringify(request);

    // Spawn Python process
    const args = [
      scriptPath,
      '--content-type', request.contentType,
      '--content-id', request.contentId,
      '--target-language', request.targetLanguage,
      '--content', requestJson,
    ];

    debugLog('[Translation Handler] Spawning Python translation service:', {
      pythonExe,
      scriptPath,
      contentType: request.contentType,
      contentId: request.contentId,
      targetLanguage: request.targetLanguage,
    });

    const proc = spawn(pythonExe, args, {
      cwd: backendPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnvManager.getPythonEnv(),
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        try {
          const response: TranslationResponse = JSON.parse(stdout);
          resolve(response);
        } catch (error) {
          debugError('[Translation Handler] Failed to parse translation response:', error);
          reject(new Error(`Invalid response from translation service: ${error}`));
        }
      } else {
        debugError('[Translation Handler] Translation service failed:', stderr);
        reject(new Error(stderr || `Translation service exited with code ${code}`));
      }
    });

    proc.on('error', (error) => {
      debugError('[Translation Handler] Failed to spawn translation service:', error);
      reject(error);
    });
  });
}

/**
 * Register all translation-related IPC handlers
 */
export function registerTranslationHandlers(
  getMainWindow: () => BrowserWindow | null
): void {
  // ============================================
  // Translation Operations
  // ============================================

  /**
   * Translate content to target language
   * Uses cache if available, otherwise calls Python translation service
   */
  ipcMain.handle(
    IPC_CHANNELS.TRANSLATION_TRANSLATE,
    async (_event, request: TranslationRequest): Promise<IPCResult<TranslationResponse>> => {
      try {
        debugLog('[Translation Handler] Translation request:', {
          contentType: request.contentType,
          contentId: request.contentId,
          targetLanguage: request.targetLanguage,
        });

        // Get project path
        const projectId = request.projectId;
        if (!projectId) {
          return { success: false, error: 'Project ID required' };
        }

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Check cache first
        const cached = loadCachedTranslation(
          project.path,
          request.contentType,
          request.contentId,
          request.targetLanguage
        );

        if (cached) {
          debugLog('[Translation Handler] Using cached translation');

          // Return cached translation as response
          const response: TranslationResponse = {
            contentType: request.contentType,
            contentId: request.contentId,
            originalContent: cached.originalContent,
            translatedContent: cached.translatedContent,
            language: request.targetLanguage,
            metadata: {
              ...cached.metadata,
              cached: true,
            },
          };

          return { success: true, data: response };
        }

        // Call Python translation service
        debugLog('[Translation Handler] Cache miss, calling translation service');

        try {
          const response = await callTranslationService(project.path, request);
          return { success: true, data: response };
        } catch (error) {
          debugError('[Translation Handler] Translation service error:', error);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Translation failed',
          };
        }
      } catch (error) {
        debugError('[Translation Handler] Translation request failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Translation request failed',
        };
      }
    }
  );

  /**
   * Revert translation to original language
   * Clears the current language selection (handled by frontend store)
   */
  ipcMain.handle(
    IPC_CHANNELS.TRANSLATION_REVERT,
    async (
      _event,
      projectId: string,
      contentType: TranslatableContentType,
      contentId: string
    ): Promise<IPCResult<void>> => {
      try {
        debugLog('[Translation Handler] Revert translation:', {
          projectId,
          contentType,
          contentId,
        });

        // Verify project exists
        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        // Revert is primarily a frontend state operation
        // Backend just confirms the project exists
        // The frontend store will handle switching back to original language

        return { success: true };
      } catch (error) {
        debugError('[Translation Handler] Revert failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Revert failed',
        };
      }
    }
  );

  /**
   * Get list of available translations for content
   */
  ipcMain.handle(
    IPC_CHANNELS.TRANSLATION_GET_AVAILABLE,
    async (
      _event,
      projectId: string,
      contentType: TranslatableContentType,
      contentId: string
    ): Promise<IPCResult<TargetLanguage[]>> => {
      try {
        debugLog('[Translation Handler] Get available translations:', {
          projectId,
          contentType,
          contentId,
        });

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const availableLanguages = getAvailableTranslations(
          project.path,
          contentType,
          contentId
        );

        return { success: true, data: availableLanguages };
      } catch (error) {
        debugError('[Translation Handler] Failed to get available translations:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get available translations',
        };
      }
    }
  );

  /**
   * Clear all translations for specific content
   */
  ipcMain.handle(
    IPC_CHANNELS.TRANSLATION_CLEAR,
    async (
      _event,
      projectId: string,
      contentType: TranslatableContentType,
      contentId: string
    ): Promise<IPCResult<void>> => {
      try {
        debugLog('[Translation Handler] Clear translations:', {
          projectId,
          contentType,
          contentId,
        });

        const project = projectStore.getProject(projectId);
        if (!project) {
          return { success: false, error: 'Project not found' };
        }

        const translationsDir = path.join(
          project.path,
          '.auto-claude',
          'translations',
          contentType,
          contentId
        );

        if (existsSync(translationsDir)) {
          const fs = require('fs');
          fs.rmSync(translationsDir, { recursive: true, force: true });
          debugLog('[Translation Handler] Cleared translations directory');
        }

        return { success: true };
      } catch (error) {
        debugError('[Translation Handler] Failed to clear translations:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to clear translations',
        };
      }
    }
  );
}
