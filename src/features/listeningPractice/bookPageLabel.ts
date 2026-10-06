const VERIFIED_PAGE_LABELS: Readonly<Record<string, (imageIndex: number) => string | undefined>> = {
  "9": (imageIndex) => {
    if (imageIndex === 0) return "封面";
    if (imageIndex === 1) return "扉页";
    if (imageIndex === 2) return "空白页";
    if (imageIndex >= 3) return `第 ${imageIndex} 页`;
    return undefined;
  },
};

export const resolveBookPageLabel = (
  bookId: string,
  imageIndex: number,
  pageNumber: number,
): string | undefined => {
  const verified = VERIFIED_PAGE_LABELS[bookId]?.(imageIndex);
  if (verified) return verified;
  return pageNumber === 0 ? "封面" : undefined;
};
