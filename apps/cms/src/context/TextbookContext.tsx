import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Textbook, ProblemFolder } from '@shared/types/database';

/**
 * 선택 상태 (2026-08-26 폴더 개편).
 * 예전엔 chapter/subchapter 두 칸이 고정돼 있어 깊이가 3단에 묶여 있었다.
 * 이제는 **선택된 폴더 하나 + 그 조상 경로**만 들고 다니므로 깊이 제한이 없다.
 */
interface TextbookContextType {
  selectedTextbook: Textbook | null;
  selectedFolder: ProblemFolder | null;
  /** 최상위 → 선택된 폴더 순서. 브레드크럼·상위 이동에 쓴다. */
  folderPath: ProblemFolder[];
  setTextbook: (textbook: Textbook | null) => void;
  setFolder: (folder: ProblemFolder | null, path?: ProblemFolder[]) => void;
  clearSelection: () => void;
  breadcrumb: string;
}

const TextbookContext = createContext<TextbookContextType | null>(null);

// 옛 키(cms_textbook_selection)는 chapter/subchapter 모양이라 그대로 읽으면 깨진다.
// 키를 바꿔 옛 값을 자연히 버린다.
const STORAGE_KEY = 'cms_textbook_selection_v2';

export const TextbookProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(null);
  const [selectedFolder, setSelectedFolder] = useState<ProblemFolder | null>(null);
  const [folderPath, setFolderPath] = useState<ProblemFolder[]>([]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (parsed.textbook) setSelectedTextbook(parsed.textbook);
      if (parsed.folder) setSelectedFolder(parsed.folder);
      if (Array.isArray(parsed.path)) setFolderPath(parsed.path);
    } catch {
      // 깨진 값이면 그냥 초기 상태로 둔다
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      textbook: selectedTextbook,
      folder: selectedFolder,
      path: folderPath,
    }));
  }, [selectedTextbook, selectedFolder, folderPath]);

  const setTextbook = useCallback((textbook: Textbook | null) => {
    setSelectedTextbook(textbook);
    setSelectedFolder(null);
    setFolderPath([]);
  }, []);

  const setFolder = useCallback((folder: ProblemFolder | null, path?: ProblemFolder[]) => {
    setSelectedFolder(folder);
    setFolderPath(folder ? (path ?? [folder]) : []);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedTextbook(null);
    setSelectedFolder(null);
    setFolderPath([]);
  }, []);

  const breadcrumb = [selectedTextbook?.name, ...folderPath.map(f => f.name)]
    .filter(Boolean).join(' > ');

  return (
    <TextbookContext.Provider value={{
      selectedTextbook,
      selectedFolder,
      folderPath,
      setTextbook,
      setFolder,
      clearSelection,
      breadcrumb,
    }}>
      {children}
    </TextbookContext.Provider>
  );
};

export const useTextbook = () => {
  const context = useContext(TextbookContext);
  if (!context) {
    throw new Error('useTextbook must be used within a TextbookProvider');
  }
  return context;
};
