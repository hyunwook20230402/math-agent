import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { Textbook, Chapter, Subchapter } from '@shared/types/database';

interface TextbookContextType {
  selectedTextbook: Textbook | null;
  selectedChapter: Chapter | null;
  selectedSubchapter: Subchapter | null;
  setTextbook: (textbook: Textbook | null) => void;
  setChapter: (chapter: Chapter | null) => void;
  setSubchapter: (subchapter: Subchapter | null) => void;
  clearSelection: () => void;
  breadcrumb: string;
}

const TextbookContext = createContext<TextbookContextType | null>(null);

const STORAGE_KEY = 'cms_textbook_selection';

export const TextbookProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [selectedTextbook, setSelectedTextbook] = useState<Textbook | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<Chapter | null>(null);
  const [selectedSubchapter, setSelectedSubchapter] = useState<Subchapter | null>(null);

  // localStorage에서 복원
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed.textbook) setSelectedTextbook(parsed.textbook);
        if (parsed.chapter) setSelectedChapter(parsed.chapter);
        if (parsed.subchapter) setSelectedSubchapter(parsed.subchapter);
      }
    } catch {
      // ignore
    }
  }, []);

  // localStorage에 저장
  useEffect(() => {
    const data = {
      textbook: selectedTextbook,
      chapter: selectedChapter,
      subchapter: selectedSubchapter,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }, [selectedTextbook, selectedChapter, selectedSubchapter]);

  const setTextbook = useCallback((textbook: Textbook | null) => {
    setSelectedTextbook(textbook);
    setSelectedChapter(null);
    setSelectedSubchapter(null);
  }, []);

  const setChapter = useCallback((chapter: Chapter | null) => {
    setSelectedChapter(chapter);
    setSelectedSubchapter(null);
  }, []);

  const setSubchapter = useCallback((subchapter: Subchapter | null) => {
    setSelectedSubchapter(subchapter);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedTextbook(null);
    setSelectedChapter(null);
    setSelectedSubchapter(null);
  }, []);

  const breadcrumb = [
    selectedTextbook?.name,
    selectedChapter?.name,
    selectedSubchapter?.name,
  ].filter(Boolean).join(' > ');

  return (
    <TextbookContext.Provider value={{
      selectedTextbook,
      selectedChapter,
      selectedSubchapter,
      setTextbook,
      setChapter,
      setSubchapter,
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
