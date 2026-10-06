const resolveCasaPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "目录";
  if (imageIndex >= 2) return `第 ${imageIndex - 1} 页`;
  return undefined;
};

const resolvePetStudentBookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex >= 1 && imageIndex <= 209) return `第 ${imageIndex + 2} 页`;
  return undefined;
};

const resolvePetWorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2) return "版权页";
  if (imageIndex >= 3 && imageIndex <= 79) return `第 ${imageIndex} 页`;
  return undefined;
};

const resolveKetWorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2) return "版权页";
  if (imageIndex >= 3 && imageIndex <= 75) return `第 ${imageIndex} 页`;
  if (imageIndex === 76) return "空白页";
  return undefined;
};

const resolveOurWorld1StudentPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "目录";
  if (imageIndex >= 2 && imageIndex <= 183) return `第 ${imageIndex} 页`;
  if (imageIndex >= 184 && imageIndex <= 191) return "贴纸";
  if (imageIndex === 192) return "空白页";
  return undefined;
};

const resolveOurWorld1WorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2) return "目录";
  if (imageIndex >= 3 && imageIndex <= 5) return `第 ${imageIndex} 页`;
  if (imageIndex >= 6 && imageIndex <= 79) return `第 ${imageIndex - 2} 页`;
  if (imageIndex >= 80 && imageIndex <= 126) return `第 ${imageIndex} 页`;
  if (imageIndex === 127) return "致谢";
  return undefined;
};

const resolveOurWorldStarterStudentPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2) return "空白页";
  if (imageIndex === 3) return "目录";
  if (imageIndex >= 4 && imageIndex <= 103) return `第 ${imageIndex} 页`;
  if (imageIndex >= 104 && imageIndex <= 111) return "贴纸";
  if (imageIndex === 112) return "致谢";
  return undefined;
};

const resolveOurWorldStarterWorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "目录";
  if (imageIndex >= 2 && imageIndex <= 63) return `第 ${imageIndex} 页`;
  if (imageIndex === 64) return "空白页";
  if (imageIndex === 65) return "致谢";
  return undefined;
};

const resolveOxfordDiscoverPageLabel = (
  copyrightIndex: number,
) => (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === copyrightIndex) return "版权页";
  if (imageIndex >= 2 && imageIndex < copyrightIndex) return `第 ${imageIndex} 页`;
  return undefined;
};

const resolveReadingExplorerPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2) return "版权页";
  if (imageIndex === 3) return "目录";
  if (imageIndex >= 4) return `第 ${imageIndex} 页`;
  return undefined;
};

const resolveThinkStudentBookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex === 2 || imageIndex === 3) return "目录";
  if (imageIndex >= 4 && imageIndex <= 128) return `第 ${imageIndex} 页`;
  if (imageIndex >= 129 && imageIndex <= 131) return "致谢";
  return undefined;
};

const resolveThinkWorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "扉页";
  if (imageIndex >= 1 && imageIndex <= 125) return `第 ${imageIndex + 3} 页`;
  return undefined;
};

const resolveOxfordDiscover6StudentPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "扉页";
  if (imageIndex >= 2 && imageIndex <= 5) return "Scope and Sequence";
  if (imageIndex >= 6 && imageIndex <= 200) return `第 ${imageIndex} 页`;
  return undefined;
};

const resolveOxfordDiscover6WorkbookPageLabel = (imageIndex: number): string | undefined => {
  if (imageIndex === 0) return "封面";
  if (imageIndex === 1) return "目录";
  if (imageIndex >= 2 && imageIndex <= 184) return `第 ${imageIndex} 页`;
  return undefined;
};

const VERIFIED_PAGE_LABELS: Readonly<Record<string, (imageIndex: number) => string | undefined>> = {
  "3": resolveCasaPageLabel,
  "4": resolveCasaPageLabel,
  "5": resolveCasaPageLabel,
  "6": resolveCasaPageLabel,
  "7": resolvePetStudentBookPageLabel,
  "8": resolvePetWorkbookPageLabel,
  "9": (imageIndex) => {
    if (imageIndex === 0) return "封面";
    if (imageIndex === 1) return "扉页";
    if (imageIndex === 2) return "空白页";
    if (imageIndex >= 3) return `第 ${imageIndex} 页`;
    return undefined;
  },
  "10": resolveKetWorkbookPageLabel,
  "11": resolveOurWorld1StudentPageLabel,
  "12": resolveOurWorld1WorkbookPageLabel,
  "13": resolveOurWorldStarterStudentPageLabel,
  "14": resolveOurWorldStarterWorkbookPageLabel,
  "15": resolveOxfordDiscoverPageLabel(192),
  "16": resolveOxfordDiscoverPageLabel(192),
  "17": resolveOxfordDiscoverPageLabel(193),
  "18": resolveOxfordDiscoverPageLabel(193),
  "19": resolveOxfordDiscoverPageLabel(201),
  "20": resolveReadingExplorerPageLabel,
  "21": resolveReadingExplorerPageLabel,
  "22": resolveReadingExplorerPageLabel,
  "23": resolveReadingExplorerPageLabel,
  "24": resolveReadingExplorerPageLabel,
  "25": resolveReadingExplorerPageLabel,
  "26": resolveThinkStudentBookPageLabel,
  "27": resolveThinkWorkbookPageLabel,
  "28": resolveThinkStudentBookPageLabel,
  "29": resolveThinkWorkbookPageLabel,
  "30": resolveOxfordDiscover6StudentPageLabel,
  "31": resolveOxfordDiscover6WorkbookPageLabel,
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
