import { useState, useCallback, useRef, useEffect } from "react";

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  wordIndex: number;
  messageId: string | null;
  text: string;
}

export function useWordContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    wordIndex: 0,
    messageId: null,
    text: "",
  });

  const showMenu = useCallback((
    e: React.MouseEvent,
    wordIndex: number,
    messageId: string,
    text: string
  ) => {
    e.preventDefault();
    setMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      wordIndex,
      messageId,
      text,
    });
  }, []);

  const hideMenu = useCallback(() => {
    setMenu(prev => ({ ...prev, visible: false }));
  }, []);

  // Hide menu on click outside
  useEffect(() => {
    if (!menu.visible) return;
    
    const handleClick = () => hideMenu();
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menu.visible, hideMenu]);

  return {
    menu,
    showMenu,
    hideMenu,
  };
}

export default useWordContextMenu;
