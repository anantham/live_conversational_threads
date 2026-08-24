import { useCallback, useRef, useState } from "react";

function carriesFiles(event) {
  return (
    Array.from(event.dataTransfer?.types || []).includes("Files") ||
    Boolean(event.dataTransfer?.files?.length)
  );
}

/**
 * Whole-surface file-drop behavior with nested-element drag accounting.
 * Validation remains the responsibility of the caller's shared file opener.
 */
export function useThreadsFileDrop(onFile) {
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const dragDepth = useRef(0);

  const onDragEnter = useCallback((event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setIsDraggingFile(true);
  }, []);

  const onDragOver = useCallback((event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDragLeave = useCallback((event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDraggingFile(false);
  }, []);

  const onDrop = useCallback((event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setIsDraggingFile(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void onFile(file);
  }, [onFile]);

  return {
    isDraggingFile,
    dropTargetProps: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
