import practiceManifest from './practiceManifest.json';

/**
 * 设计原型使用真实书架资源；书籍 ID 与小程序保持一致，1、2 为广告且不列入书目。
 * available 仅表示本原型提供了可打开的训练预览，不代表其余教材已经接入。
 */
export type Book = {
  id: string;
  seriesId: string;
  title: string;
  level: string;
  kind: string;
  cover: string;
  available: boolean;
};

export type BookSeries = {
  id: string;
  title: string;
  subtitle: string;
  cover: string;
  availableCount: number;
};

export type PracticePreview = {
  id: string;
  bookId: string;
  section: string;
  /** 沿用源图片文件页号，并非印刷页码或预览列表序号。 */
  pageNumber: number;
  image: string;
  tracks: {
    id: string;
    label: string;
    src: string;
    /** 相对等比完整图片的百分比坐标，渲染时加上 %。 */
    left: number;
    top: number;
  }[];
};

export const books: Book[] = [
  { id: '3', seriesId: 'casa', title: 'CASA 阅读与自然拼读 1', level: '第 1 册', kind: '阅读与自然拼读', cover: '/assets/books/book-3.png', available: true },
  { id: '4', seriesId: 'casa', title: 'CASA 阅读与自然拼读 2', level: '第 2 册', kind: '阅读与自然拼读', cover: '/assets/books/book-4.png', available: false },
  { id: '5', seriesId: 'casa', title: 'CASA 阅读与自然拼读 3', level: '第 3 册', kind: '阅读与自然拼读', cover: '/assets/books/book-5.png', available: false },
  { id: '6', seriesId: 'casa', title: 'CASA 阅读与自然拼读 4', level: '第 4 册', kind: '阅读与自然拼读', cover: '/assets/books/book-6.png', available: false },
  { id: '7', seriesId: 'cambridge', title: '剑桥 PET 综合教程 · 学生用书', level: 'B1 · PET', kind: '学生用书', cover: '/assets/books/book-7.png', available: false },
  { id: '8', seriesId: 'cambridge', title: '剑桥 PET 综合教程 · 练习册', level: 'B1 · PET', kind: '练习册', cover: '/assets/books/book-8.png', available: false },
  { id: '9', seriesId: 'cambridge', title: '剑桥 KET 综合教程 · 学生用书', level: 'A2 · KET', kind: '学生用书', cover: '/assets/books/book-9.png', available: false },
  { id: '10', seriesId: 'cambridge', title: '剑桥 KET 综合教程 · 练习册', level: 'A2 · KET', kind: '练习册', cover: '/assets/books/book-10.png', available: false },
  { id: '11', seriesId: 'our-world', title: 'Our World 1 · 学生用书', level: 'Level 1', kind: '学生用书', cover: '/assets/books/book-11.jpg', available: false },
  { id: '12', seriesId: 'our-world', title: 'Our World 1 · 练习册', level: 'Level 1', kind: '练习册', cover: '/assets/books/book-12.jpg', available: false },
  { id: '13', seriesId: 'our-world', title: 'Our World Starter · 学生用书', level: 'Starter', kind: '学生用书', cover: '/assets/books/book-13.jpg', available: false },
  { id: '14', seriesId: 'our-world', title: 'Our World Starter · 练习册', level: 'Starter', kind: '练习册', cover: '/assets/books/book-14.jpg', available: false },
  // 原始常量注释中的 1st–5th 对应级别，实际封面为第二版，不能误标为五个版次。
  { id: '15', seriesId: 'oxford-discover', title: 'Oxford Discover 1', level: 'Level 1', kind: '学生用书', cover: '/assets/books/book-15.jpg', available: false },
  { id: '16', seriesId: 'oxford-discover', title: 'Oxford Discover 2', level: 'Level 2', kind: '学生用书', cover: '/assets/books/book-16.jpg', available: false },
  { id: '17', seriesId: 'oxford-discover', title: 'Oxford Discover 3', level: 'Level 3', kind: '学生用书', cover: '/assets/books/book-17.jpg', available: false },
  { id: '18', seriesId: 'oxford-discover', title: 'Oxford Discover 4', level: 'Level 4', kind: '学生用书', cover: '/assets/books/book-18.jpg', available: false },
  { id: '19', seriesId: 'oxford-discover', title: 'Oxford Discover 5', level: 'Level 5', kind: '学生用书', cover: '/assets/books/book-19.jpg', available: false },
  { id: '20', seriesId: 'reading-explorer', title: 'Reading Explorer Foundations', level: 'Foundations', kind: '学生用书', cover: '/assets/books/book-20.jpg', available: false },
  { id: '21', seriesId: 'reading-explorer', title: 'Reading Explorer 1', level: 'Level 1', kind: '学生用书', cover: '/assets/books/book-21.jpg', available: false },
  { id: '22', seriesId: 'reading-explorer', title: 'Reading Explorer 2', level: 'Level 2', kind: '学生用书', cover: '/assets/books/book-22.jpg', available: false },
  { id: '23', seriesId: 'reading-explorer', title: 'Reading Explorer 3', level: 'Level 3', kind: '学生用书', cover: '/assets/books/book-23.jpg', available: false },
  { id: '24', seriesId: 'reading-explorer', title: 'Reading Explorer 4', level: 'Level 4', kind: '学生用书', cover: '/assets/books/book-24.jpg', available: false },
  { id: '25', seriesId: 'reading-explorer', title: 'Reading Explorer 5', level: 'Level 5', kind: '学生用书', cover: '/assets/books/book-25.jpg', available: false },
];

/** 系列卡片按设计稿顺序展示，计数仅统计实际能预览的书。 */
export const series: BookSeries[] = [
  { id: 'casa', title: 'CASA 阅读与自然拼读', subtitle: '阅读启蒙 · 自然拼读', cover: '/assets/books/book-3.png', availableCount: 1 },
  { id: 'our-world', title: 'Our World', subtitle: '探索世界 · 综合英语', cover: '/assets/books/book-12.jpg', availableCount: 0 },
  { id: 'oxford-discover', title: 'Oxford Discover', subtitle: '问题探究 · 英语表达', cover: '/assets/books/book-19.jpg', availableCount: 0 },
  { id: 'reading-explorer', title: 'Reading Explorer', subtitle: '分级阅读 · 拓展视野', cover: '/assets/books/book-23.jpg', availableCount: 0 },
  { id: 'cambridge', title: '剑桥英语', subtitle: 'KET / PET · 考试进阶', cover: '/assets/books/book-9.png', availableCount: 0 },
];

/**
 * 来源：images.ts、audioList.ts、catalogList.ts，运行 scripts/sync-book-assets.cjs 可复核映射。
 * 采用当前小程序 book3Practice.ts 的坐标公式：(x−653)/469、(y−167)/606，再换算为百分比。
 * CASA 原图列表删除过第 2 张，因此必须按文件后缀页号匹配音频，不能使用图片数组下标。
 */
export const practicePreviews: PracticePreview[] = practiceManifest;
