import { ScrollView, Text, View } from "@tarojs/components";
import {
  findPracticeDirectoryGroupId,
  type PracticeDirectoryGroup,
} from "@/features/listeningPractice/practiceDirectory";

interface PracticeDirectoryProps {
  groups: readonly PracticeDirectoryGroup[];
  currentPracticeIndex: number;
  open: boolean;
  onClose: () => void;
  onSelect: (practiceIndex: number) => void;
}

/** 底部训练目录只展示带示范音频的页面，并自动定位当前章节。 */
export default function PracticeDirectory({
  groups,
  currentPracticeIndex,
  open,
  onClose,
  onSelect,
}: PracticeDirectoryProps) {
  if (!open) return null;

  const currentGroupId = findPracticeDirectoryGroupId(
    groups,
    currentPracticeIndex
  );

  return (
    <View className='practice-directory-mask' onClick={onClose}>
      <View
        className='practice-directory-sheet'
        onClick={(event) => event.stopPropagation()}
      >
        <View className='practice-directory-header'>
          <Text className='practice-directory-title'>训练目录</Text>
          <Text
            className='practice-directory-close device-touch-target'
            onClick={onClose}
          >
            关闭
          </Text>
        </View>
        <ScrollView
          className='practice-directory-scroll'
          scrollY
          scrollIntoView={currentGroupId}
        >
          {groups.map((group) => (
            <View
              id={group.id}
              key={group.id}
              className='practice-directory-group'
            >
              <Text className='practice-directory-group__title'>
                {group.title}
              </Text>
              <View className='practice-directory-items'>
                {group.items.map((item) => (
                  <View
                    key={item.id}
                    className={`practice-directory-item device-touch-target ${
                      item.practiceIndex === currentPracticeIndex
                        ? "practice-directory-item--active"
                        : ""
                    }`}
                    onClick={() => onSelect(item.practiceIndex)}
                  >
                    <Text className='practice-directory-item__page'>
                      {`第 ${item.pageNumber} 页`}
                    </Text>
                    <Text className='practice-directory-item__tracks'>
                      {`${item.trackCount} 段音频`}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    </View>
  );
}
