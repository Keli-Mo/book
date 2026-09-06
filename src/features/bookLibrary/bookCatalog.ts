export type BookSeriesId =
  | "casa"
  | "our-world"
  | "oxford-discover"
  | "reading-explorer"
  | "cambridge";

export type BookCatalogItem = {
  id: string;
  seriesId: BookSeriesId;
  title: string;
  level: string;
  kind: string;
  cover: string;
  available: boolean;
};

export type BookSeries = {
  id: BookSeriesId;
  title: string;
  shortTitle: string;
  rangeLabel: string;
  cover: string;
  availableCount: number;
};

export type BookOpenAction =
  | { type: "practice"; url: string }
  | { type: "unavailable"; message: string };

const COVER_ORIGIN =
  "https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la";

// 沿用现有云存储封面地址，避免把 23 张图片打进小程序主包。
const cover = (cloudPath: string) => `${COVER_ORIGIN}/${cloudPath}`;

export const BOOKS: BookCatalogItem[] = [
  {
    id: "3",
    seriesId: "casa",
    title: "CASA 阅读与自然拼读 1",
    level: "第 1 册",
    kind: "阅读与自然拼读",
    cover: cover(
      "1.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%201_1.png",
    ),
    available: true,
  },
  {
    id: "4",
    seriesId: "casa",
    title: "CASA 阅读与自然拼读 2",
    level: "第 2 册",
    kind: "阅读与自然拼读",
    cover: cover(
      "2.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%202_1.png",
    ),
    available: false,
  },
  {
    id: "5",
    seriesId: "casa",
    title: "CASA 阅读与自然拼读 3",
    level: "第 3 册",
    kind: "阅读与自然拼读",
    cover: cover(
      "3.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%203_1.png",
    ),
    available: false,
  },
  {
    id: "6",
    seriesId: "casa",
    title: "CASA 阅读与自然拼读 4",
    level: "第 4 册",
    kind: "阅读与自然拼读",
    cover: cover(
      "4.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%204_1.png",
    ),
    available: false,
  },
  {
    id: "7",
    seriesId: "cambridge",
    title: "剑桥 PET 综合教程 · 学生用书",
    level: "B1 · PET",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/%E5%89%91%E6%A1%A5PET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E5%AD%A6%E7%94%A8%E4%B9%A6B1.png",
    ),
    available: false,
  },
  {
    id: "8",
    seriesId: "cambridge",
    title: "剑桥 PET 综合教程 · 练习册",
    level: "B1 · PET",
    kind: "练习册",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/%E5%89%91%E6%A1%A5PET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E7%BB%83%E4%B9%A0%E5%86%8CB1.png",
    ),
    available: false,
  },
  {
    id: "9",
    seriesId: "cambridge",
    title: "剑桥 KET 综合教程 · 学生用书",
    level: "A2 · KET",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/%E5%89%91%E6%A1%A5KET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E5%AD%A6%E7%94%A8%E4%B9%A6A2.png",
    ),
    available: false,
  },
  {
    id: "10",
    seriesId: "cambridge",
    title: "剑桥 KET 综合教程 · 练习册",
    level: "A2 · KET",
    kind: "练习册",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/%E5%89%91%E6%A1%A5KET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E7%BB%83%E4%B9%A0%E5%86%8CA2.png",
    ),
    available: false,
  },
  {
    id: "11",
    seriesId: "our-world",
    title: "Our World 1 · 学生用书",
    level: "Level 1",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_2E_L1_Studentbook.png",
    ),
    available: false,
  },
  {
    id: "12",
    seriesId: "our-world",
    title: "Our World 1 · 练习册",
    level: "Level 1",
    kind: "练习册",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_L1_Workbook.png",
    ),
    available: false,
  },
  {
    id: "13",
    seriesId: "our-world",
    title: "Our World Starter · 学生用书",
    level: "Starter",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_Starter_Studentbook.png",
    ),
    available: false,
  },
  {
    id: "14",
    seriesId: "our-world",
    title: "Our World Starter · 练习册",
    level: "Starter",
    kind: "练习册",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_Starter_Workbook-1.png",
    ),
    available: false,
  },
  // 原注释写的是 1st–5th edition，实际资源是第二版的 1–5 级。
  {
    id: "15",
    seriesId: "oxford-discover",
    title: "Oxford Discover 1",
    level: "Level 1",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OD_2E_L1_1.jpg",
    ),
    available: false,
  },
  {
    id: "16",
    seriesId: "oxford-discover",
    title: "Oxford Discover 2",
    level: "Level 2",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OD_2E_L2_1.jpg",
    ),
    available: false,
  },
  {
    id: "17",
    seriesId: "oxford-discover",
    title: "Oxford Discover 3",
    level: "Level 3",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OD_2E_L3_1.jpg",
    ),
    available: false,
  },
  {
    id: "18",
    seriesId: "oxford-discover",
    title: "Oxford Discover 4",
    level: "Level 4",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OD_2E_L4_1.jpg",
    ),
    available: false,
  },
  {
    id: "19",
    seriesId: "oxford-discover",
    title: "Oxford Discover 5",
    level: "Level 5",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OD_2E_L1_5.jpg",
    ),
    available: false,
  },
  {
    id: "20",
    seriesId: "reading-explorer",
    title: "Reading Explorer Foundations",
    level: "Foundations",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_Foundations_Studentbook.jpg",
    ),
    available: false,
  },
  {
    id: "21",
    seriesId: "reading-explorer",
    title: "Reading Explorer 1",
    level: "Level 1",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_L1_Studentbook.jpg",
    ),
    available: false,
  },
  {
    id: "22",
    seriesId: "reading-explorer",
    title: "Reading Explorer 2",
    level: "Level 2",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_L2_Studentbook.jpg",
    ),
    available: false,
  },
  {
    id: "23",
    seriesId: "reading-explorer",
    title: "Reading Explorer 3",
    level: "Level 3",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_L3_Studentbook.jpg",
    ),
    available: false,
  },
  {
    id: "24",
    seriesId: "reading-explorer",
    title: "Reading Explorer 4",
    level: "Level 4",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_L4_Studentbook.jpg",
    ),
    available: false,
  },
  {
    id: "25",
    seriesId: "reading-explorer",
    title: "Reading Explorer 5",
    level: "Level 5",
    kind: "学生用书",
    cover: cover(
      "%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/ReadingExplorer_L5_Studentbook.jpg",
    ),
    available: false,
  },
];

const bookById = new Map(BOOKS.map((book) => [book.id, book]));

const requireBook = (id: string) => {
  const book = bookById.get(id);
  if (!book) throw new Error(`找不到教材 ${id}`);
  return book;
};

export const BOOK_SERIES: BookSeries[] = [
  {
    id: "casa",
    title: "CASA 阅读与自然拼读",
    shortTitle: "CASA",
    rangeLabel: "1–4 册",
    cover: requireBook("3").cover,
    availableCount: 1,
  },
  {
    id: "our-world",
    title: "Our World",
    shortTitle: "Our World",
    rangeLabel: "Starter · Level 1",
    cover: requireBook("12").cover,
    availableCount: 0,
  },
  {
    id: "oxford-discover",
    title: "Oxford Discover",
    shortTitle: "Oxford",
    rangeLabel: "Level 1–5",
    cover: requireBook("19").cover,
    availableCount: 0,
  },
  {
    id: "reading-explorer",
    title: "Reading Explorer",
    shortTitle: "Reading Explorer",
    rangeLabel: "Foundations · Level 1–5",
    cover: requireBook("23").cover,
    availableCount: 0,
  },
  {
    id: "cambridge",
    title: "剑桥 KET / PET",
    shortTitle: "剑桥",
    rangeLabel: "A2 · B1 · 学生书 / 练习册",
    cover: requireBook("9").cover,
    availableCount: 0,
  },
];

/**
 * 书架页使用同一份筛选方法，保证系列入口和关键词搜索能够叠加。
 */
export const filterBooks = (
  books: BookCatalogItem[],
  seriesId: BookSeriesId | "all",
  query: string,
) => {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return books.filter((book) => {
    const matchesSeries = seriesId === "all" || book.seriesId === seriesId;
    const searchableText = `${book.title} ${book.level} ${book.kind}`.toLocaleLowerCase();
    return matchesSeries && (!normalizedQuery || searchableText.includes(normalizedQuery));
  });
};

/**
 * 所有书籍入口统一经过这里，防止尚未核对页码与音频的教材误入训练页。
 */
export const resolveBookAction = (book: BookCatalogItem): BookOpenAction =>
  book.available
    ? { type: "practice", url: "/pages/Practice/Practice?practice=0" }
    : {
        type: "unavailable",
        message: "这本教材正在核对页面与音频，暂未开放",
      };
