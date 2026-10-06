import { ScrollView, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
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

/** 目录在跟读页里一直挂着，关闭只隐藏。选中页后仍展开它所在的章节。 */
export default function PracticeDirectory(props: PracticeDirectoryProps) {
  return <DirectoryContents {...props} />;
}

function DirectoryContents({
  groups,
  currentPracticeIndex,
  open,
  onClose,
  onSelect,
}: PracticeDirectoryProps) {
  const currentGroupId = findPracticeDirectoryGroupId(
    groups,
    currentPracticeIndex
  );
  const currentGroup = groups.find((group) => group.id === currentGroupId);
  const currentItem = currentGroup?.items.find(
    (item) => item.practiceIndex === currentPracticeIndex
  );
  const [expandedGroupId, setExpandedGroupId] = useState(currentGroupId);
  const [scrollTarget, setScrollTarget] = useState("");
  const [scrollTop, setScrollTop] = useState<number | undefined>(undefined);
  const [locateRequest, setLocateRequest] = useState(0);
  const appliedLocateRequestRef = useRef(0);
  const savedScrollTopRef = useRef(0);

  useEffect(() => {
    setExpandedGroupId(currentGroupId);
  }, [currentGroupId]);

  useEffect(() => {
    if (!open) {
      setScrollTarget("");
      setScrollTop(undefined);
      return undefined;
    }
    if (locateRequest !== 0 && locateRequest !== appliedLocateRequestRef.current) {
      return undefined;
    }
    const top = savedScrollTopRef.current;
    if (top <= 0) return undefined;
    // 隐藏期间原生滚动会回到顶部，重新显示后要写回关闭前的位置。
    setScrollTop(top);
    return undefined;
  }, [open, locateRequest]);

  useEffect(() => {
    if (!open) return undefined;
    if (locateRequest === 0 || locateRequest === appliedLocateRequestRef.current) {
      return undefined;
    }
    appliedLocateRequestRef.current = locateRequest;
    let cancelled = false;
    // 清空旧锚点后等待当前页渲染，重复“定位当前页”也能再次触发滚动。
    setScrollTarget("");
    const target = `practice-directory-page-${currentPracticeIndex}`;
    const locate = () => {
      if (!cancelled) setScrollTarget(target);
    };
    if (typeof Taro.nextTick === "function") {
      Taro.nextTick(locate);
    } else {
      locate();
    }
    return () => {
      cancelled = true;
    };
  }, [open, currentPracticeIndex, locateRequest]);

  return (
    <View
      className={`practice-directory-mask${open ? "" : " practice-directory-mask--hidden"}`}
      hidden={!open}
      catchMove={open}
      onClick={open ? onClose : undefined}
    >
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
        <View className='practice-directory-toolbar'>
          <Text className='practice-directory-current'>
            {currentGroup && currentItem
              ? `${currentGroup.title} · ${currentItem.pageLabel || `第 ${currentItem.pageNumber} 页`}`
              : "选择章节查看书页"}
          </Text>
          {currentItem && (
            <Text
              className='practice-directory-locate device-touch-target'
              onClick={() => {
                setExpandedGroupId(currentGroupId);
                setLocateRequest((request) => request + 1);
              }}
            >
              定位当前页
            </Text>
          )}
        </View>
        <ScrollView
          className='practice-directory-scroll'
          scrollY
          scrollTop={scrollTop}
          scrollIntoView={scrollTarget}
          onScroll={(event) => {
            if (!open) return;
            const top = event.detail?.scrollTop;
            if (typeof top === "number" && Number.isFinite(top)) {
              savedScrollTopRef.current = top;
            }
          }}
        >
          {groups.map((group) => {
            const firstItem = group.items[0];
            const displayTitle = firstItem
              ? `${firstItem.pageLabel || `第 ${firstItem.pageNumber} 页`} · ${group.title}`
              : group.title;
            return (
              <View
                id={group.id}
                key={group.id}
                className='practice-directory-group'
              >
                <View
                  className={`practice-directory-group__header device-touch-target ${
                    group.id === currentGroupId
                      ? "practice-directory-group__header--current"
                      : ""
                  }`}
                  onClick={() => setExpandedGroupId((expanded) =>
                    expanded === group.id ? "" : group.id
                  )}
                >
                  <View className='practice-directory-group__heading'>
                    <Text className='practice-directory-group__title'>
                      {displayTitle}
                    </Text>
                    {group.id === currentGroupId && (
                      <Text className='practice-directory-group__current'>当前章节</Text>
                    )}
                  </View>
                  <Text className='practice-directory-group__toggle'>
                    {group.items.length} 页 · {expandedGroupId === group.id ? "收起" : "展开"}
                  </Text>
                </View>
                {expandedGroupId === group.id && (
                  <View className='practice-directory-items'>
                    {group.items.map((item) => (
                      <View
                        id={`practice-directory-page-${item.practiceIndex}`}
                        key={item.id}
                        className={`practice-directory-item device-touch-target ${
                          item.practiceIndex === currentPracticeIndex
                            ? "practice-directory-item--active"
                            : ""
                        }`}
                        onClick={() => onSelect(item.practiceIndex)}
                      >
                        <Text className='practice-directory-item__page'>
                          {item.pageLabel || `第 ${item.pageNumber} 页`}
                        </Text>
                        <Text className='practice-directory-item__tracks'>
                          {item.practiceIndex === currentPracticeIndex ? "当前页 · " : ""}
                          {item.trackCount ? `${item.trackCount} 段音频` : "自主跟读"}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      </View>
    </View>
  );
}
