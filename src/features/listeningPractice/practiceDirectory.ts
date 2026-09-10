import type { ListeningPractice } from "./bookPractice";

export interface PracticeDirectoryItem {
  id: string;
  practiceIndex: number;
  pageNumber: number;
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
  practices: readonly ListeningPractice[]
): PracticeDirectoryGroup[] => {
  const groups: PracticeDirectoryGroup[] = [];
  const groupByTitle = new Map<string, PracticeDirectoryGroup>();

  practices.forEach((practice, practiceIndex) => {
    let group = groupByTitle.get(practice.sectionTitle);

    if (!group) {
      group = {
        id: `practice-directory-group-${groups.length}`,
        title: practice.sectionTitle,
        items: [],
      };
      groupByTitle.set(practice.sectionTitle, group);
      groups.push(group);
    }

    group.items.push({
      id: practice.id,
      practiceIndex,
      pageNumber: practice.pageNumber,
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
