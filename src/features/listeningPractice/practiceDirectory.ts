import type { ListeningPractice } from "./bookPractice";

// 目录仅消费页号、章节和音频数，旧教材模型无需具备完整通用训练项字段。
type DirectoryPractice = Pick<ListeningPractice, "id" | "pageNumber" | "pageLabel" | "pageTitle" | "sectionTitle"> & {
  tracks: readonly unknown[];
};

export interface PracticeDirectoryItem {
  id: string;
  practiceIndex: number;
  pageNumber: number;
  pageLabel?: string;
  pageTitle?: string;
  trackCount: number;
}

export interface PracticeDirectoryGroup {
  id: string;
  title: string;
  items: PracticeDirectoryItem[];
}

/**
 * 按训练页在书中的先后顺序分组，保证目录顺序与实际翻页顺序一致。
 */
export const buildPracticeDirectoryGroups = (
  practices: readonly DirectoryPractice[]
): PracticeDirectoryGroup[] => {
  const groups: PracticeDirectoryGroup[] = [];

  practices.forEach((practice, practiceIndex) => {
    let group = groups[groups.length - 1];

    // 同名小节会在不同章节重复出现，只合并连续页面，保持目录与整本页序一致。
    if (!group || group.title !== practice.sectionTitle) {
      group = {
        id: `practice-directory-group-${groups.length}`,
        title: practice.sectionTitle,
        items: [],
      };
      groups.push(group);
    }

    group.items.push({
      id: practice.id,
      practiceIndex,
      pageNumber: practice.pageNumber,
      ...(practice.pageLabel ? { pageLabel: practice.pageLabel } : {}),
      ...(practice.pageTitle ? { pageTitle: practice.pageTitle } : {}),
      trackCount: practice.tracks.length,
    });
  });

  return groups;
};

/** 获取指定训练页所属的目录分组，用于打开目录时自动定位。 */
export const findPracticeDirectoryGroupId = (
  groups: readonly PracticeDirectoryGroup[],
  practiceIndex: number
): string =>
  groups.find((group) =>
    group.items.some((item) => item.practiceIndex === practiceIndex)
  )?.id || "";
