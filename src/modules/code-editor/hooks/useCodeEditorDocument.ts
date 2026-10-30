import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useRefreshSignal } from '@/shared/hooks/useRefreshSignal';
import type { CodeEditorFile } from '@/shared/types';
import { isBinaryFile } from '@/modules/code-editor/utils/binaryFile';
import { getPreviewKind } from '@/modules/code-editor/utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
  /** The workspace's refresh token: when it moves, a clean buffer is read again from disk. */
  reloadToken?: number;
};

/** How long the "not reloaded, unsaved changes" notice stays up. */
const RELOAD_SKIPPED_NOTICE_MS = 6000;

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

/** A file the server would not read for the editor because it is over its size cap; the sizes are in bytes, when the server gives them. */
type CodeEditorTooLargeFile = {
  size: number | null;
  limit: number | null;
};

// The server refuses a read over its cap with 413 FILE_TOO_LARGE and says, in the error's details,
// how big the file is and what the cap is. Read off the error readApiJson throws.
const readTooLargeRefusal = (error: unknown): CodeEditorTooLargeFile | null => {
  const { code, status, details } = (error ?? {}) as { code?: unknown; status?: unknown; details?: unknown };
  if (code !== 'FILE_TOO_LARGE' && status !== 413) {
    return null;
  }
  const { size, limit } = (details && typeof details === 'object' ? details : {}) as { size?: unknown; limit?: unknown };
  return {
    size: typeof size === 'number' ? size : null,
    limit: typeof limit === 'number' ? limit : null,
  };
};

// CodeMirror reports its document with LF line endings whatever the file used,
// so a CRLF file would look edited from the first keystroke (and stay "edited"
// after an undo) unless both sides of the comparison are normalised.
const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, '\n');

export const useCodeEditorDocument = ({ file, projectPath, reloadToken }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  // The text as last loaded from disk or written back by a save. The buffer is
  // compared against it to tell whether closing or switching files would
  // discard edits; nothing else in the app knows that baseline.
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // Set when the server refused the file as too large to open: the editor says so instead of
  // showing an empty buffer, and never saves that empty buffer over the real file.
  const [tooLarge, setTooLarge] = useState<CodeEditorTooLargeFile | null>(null);
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;
  // Counts the loads this editor has performed. A read or save still in flight
  // when another file is opened belongs to the previous file and must not land
  // on the new one's buffer, baseline or save state.
  const loadGenerationRef = useRef(0);
  // Counts the rereads a workspace refresh started. A newer reread, or a save, makes an older one's answer
  // stale: it must not put back what the disk held before the save.
  const reloadGenerationRef = useRef(0);
  // The file whose buffer a workspace refresh left alone because it held edits: the header says so for a
  // moment. Kept as the path, so opening another file drops the notice by itself.
  const [reloadSkippedPath, setReloadSkippedPath] = useState<string | null>(null);

  useEffect(() => {
    const loadGeneration = ++loadGenerationRef.current;
    const isStaleLoad = () => loadGenerationRef.current !== loadGeneration;

    // Every load path resets the saved baseline together with the buffer, so a
    // freshly opened file (or an error placeholder) never counts as dirty.
    const applyLoadedContent = (text: string) => {
      setContent(text);
      setSavedContent(text);
    };

    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        setTooLarge(null);
        // Any save still in flight or failed belongs to the previous file.
        setSaving(false);
        setSaveError(null);

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          applyLoadedContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          applyLoadedContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          applyLoadedContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        const response = await api.readFile(fileProjectId, filePath);
        // Read through readApiJson so the API's own explanation reaches the
        // pane — a directory, a path outside the project root, a missing file.
        // The bare status showed all of those as an opaque "403 Forbidden".
        const data = await readApiJson<{ content: string }>(response);
        if (isStaleLoad()) {
          return;
        }
        applyLoadedContent(data.content);
      } catch (error) {
        if (isStaleLoad()) {
          return;
        }
        const tooLargeRefusal = readTooLargeRefusal(error);
        if (tooLargeRefusal) {
          applyLoadedContent('');
          setTooLarge(tooLargeRefusal);
          return;
        }
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        applyLoadedContent(`// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`);
      } finally {
        if (!isStaleLoad()) {
          setLoading(false);
        }
      }
    };

    loadFileContent();
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId]);

  const handleSave = useCallback(async () => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk. Nor a
    // file too large to open, whose buffer is empty.
    if (previewKind || isBinaryFile(fileName) || tooLarge) {
      return;
    }

    const saveGeneration = loadGenerationRef.current;
    const isStaleSave = () => loadGenerationRef.current !== saveGeneration;
    reloadGenerationRef.current += 1;

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      const response = await api.saveFile(fileProjectId, filePath, content);

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      // Another file loaded while this write was in flight: it owns the buffer,
      // the baseline and the save state now.
      if (isStaleSave()) {
        return;
      }

      // Baseline is the text that was actually sent: anything typed while the
      // request was in flight is still unsaved.
      setSavedContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      if (!isStaleSave()) {
        setSaveError(message);
      }
    } finally {
      if (!isStaleSave()) {
        setSaving(false);
      }
    }
  }, [content, filePath, fileProjectId, previewKind, fileName, tooLarge]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  // The baseline only changes on load and save, so it is not re-normalised on
  // every keystroke.
  const normalizedSavedContent = useMemo(() => normalizeLineEndings(savedContent), [savedContent]);

  // Preview and binary files have no editable buffer, and while a file loads
  // the buffer still belongs to the previous one. Memoised so renders that do
  // not change the buffer (a save's spinner and tick) skip the comparison.
  const hasUnsavedChanges = useMemo(
    () => (
      !loading
      && !previewKind
      && !isBinary
      && !tooLarge
      && content !== savedContent
      && normalizeLineEndings(content) !== normalizedSavedContent
    ),
    [content, isBinary, loading, normalizedSavedContent, previewKind, savedContent, tooLarge],
  );

  // What a reread checks when its answer arrives: edits typed while it was out keep the buffer.
  const latestBufferRef = useRef({ hasUnsavedChanges, saving });
  useLayoutEffect(() => {
    latestBufferRef.current = { hasUnsavedChanges, saving };
  });

  // A workspace refresh rereads the file from disk, in place (no loading state, so the editor keeps its
  // scroll and cursor), and only while the buffer is clean: edits are never dropped, the header says the
  // file was left as it is instead. Media previews refetch on their own; binaries and diffs from a chat
  // message have nothing on disk to reread here. A file refused as too large is asked for again: unlike
  // a binary, told by its extension, its size changes on disk (a log rotated or truncated).
  useRefreshSignal(reloadToken, () => {
    const hasDiffSnapshot = Boolean(file.diffInfo) && fileDiffNewString !== undefined && fileDiffOldString !== undefined;
    if (loading || previewKind || isBinary || hasDiffSnapshot || !fileProjectId) {
      return;
    }
    if (hasUnsavedChanges || saving) {
      setReloadSkippedPath(filePath);
      return;
    }
    const loadGeneration = loadGenerationRef.current;
    const reloadGeneration = ++reloadGenerationRef.current;
    const isStaleReload = () => loadGenerationRef.current !== loadGeneration || reloadGenerationRef.current !== reloadGeneration;
    void (async () => {
      try {
        const response = await api.readFile(fileProjectId, filePath);
        const data = await readApiJson<{ content: string }>(response);
        if (isStaleReload()) {
          return;
        }
        if (latestBufferRef.current.hasUnsavedChanges || latestBufferRef.current.saving) {
          setReloadSkippedPath(filePath);
          return;
        }
        setTooLarge(null);
        setContent(data.content);
        setSavedContent(data.content);
      } catch (error) {
        if (isStaleReload()) {
          return;
        }
        // Over the cap now, or still: the notice gives the file's current size, and a clean buffer of a
        // file that grew past the cap gives way to it, so the editor says why it no longer follows the disk.
        const tooLargeRefusal = readTooLargeRefusal(error);
        if (tooLargeRefusal) {
          if (latestBufferRef.current.hasUnsavedChanges || latestBufferRef.current.saving) {
            setReloadSkippedPath(filePath);
            return;
          }
          setContent('');
          setSavedContent('');
          setTooLarge(tooLargeRefusal);
          return;
        }
        // The buffer stays as it was: an error placeholder would replace a file that is fine on screen.
        console.error('Error reloading file:', error);
      }
    })();
  });

  // The notice shows while that file is open with edits still unsaved, and goes after a short while.
  const reloadSkipped = reloadSkippedPath === filePath && (hasUnsavedChanges || saving);
  useEffect(() => {
    if (reloadSkippedPath === null) {
      return undefined;
    }
    const timer = window.setTimeout(() => setReloadSkippedPath(null), RELOAD_SKIPPED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [reloadSkippedPath]);

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    tooLarge,
    previewKind,
    fileProjectId,
    hasUnsavedChanges,
    reloadSkipped,
    handleSave,
    handleDownload,
  };
};
