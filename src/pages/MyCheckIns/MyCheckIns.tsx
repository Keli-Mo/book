import { Button, Image, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useCallback, useState } from "react";
import {
  CheckInSummary,
  getReadableCloudError,
  listMyCheckIns,
  removeCheckIn,
} from "@/services/cloudCheckIn";
import {
  formatCheckInTime,
  formatRecordingDuration,
} from "@/utils/checkInFormat";
import { DEFAULT_BOOK_ID } from "@/features/listeningPractice/bookPractice";

import "./MyCheckIns.scss";

export default function MyCheckIns() {
  const [records, setRecords] = useState<CheckInSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  const loadRecords = useCallback(async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      setRecords(await listMyCheckIns());
    } catch (error) {
      setErrorMessage(getReadableCloudError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useDidShow(() => {
    loadRecords();
  });

  const openRecord = (record: CheckInSummary) => {
    Taro.navigateTo({
      url: `/pages/CheckInDetail/CheckInDetail?id=${encodeURIComponent(
        record.id,
      )}&token=${encodeURIComponent(record.shareToken)}`,
    });
  };

  const deleteRecord = async (record: CheckInSummary) => {
    const confirmation = await Taro.showModal({
      title: "删除这次打卡？",
      content: "删除后，云端录音和分享链接都会失效，且无法恢复。",
      confirmText: "删除",
      confirmColor: "#d9573f",
    });
    if (!confirmation.confirm) return;

    Taro.showLoading({ title: "正在删除", mask: true });
    try {
      await removeCheckIn(record.id);
      setRecords((current) => current.filter((item) => item.id !== record.id));
      Taro.hideLoading();
      Taro.showToast({ title: "已删除", icon: "success" });
    } catch (error) {
      Taro.hideLoading();
      Taro.showModal({
        title: "删除失败",
        content: getReadableCloudError(error),
        showCancel: false,
      });
    }
  };

  if (loading) {
    return <View className='my-check-ins-state'>正在读取我的打卡…</View>;
  }

  if (errorMessage) {
    return (
      <View className='my-check-ins-state'>
        <Text className='my-check-ins-state__title'>暂时无法读取打卡</Text>
        <Text className='my-check-ins-state__text'>{errorMessage}</Text>
        <Button className='my-check-ins-state__button' onClick={loadRecords}>重新加载</Button>
      </View>
    );
  }

  if (records.length === 0) {
    return (
      <View className='my-check-ins-state'>
        <Text className='my-check-ins-state__title'>还没有跟读打卡</Text>
        <Text className='my-check-ins-state__text'>完成一段录音并确认上传后，会显示在这里。</Text>
        <Button
          className='my-check-ins-state__button'
          onClick={() =>
            Taro.navigateTo({
              url: `/pages/Practice/Practice?bookId=${DEFAULT_BOOK_ID}&practice=0`,
            })
          }
        >
          开始第一次跟读
        </Button>
      </View>
    );
  }

  return (
    <View className='my-check-ins'>
      <View className='my-check-ins__intro'>
        <Text className='my-check-ins__title'>我的录音打卡</Text>
        <Text className='my-check-ins__tip'>共 {records.length} 次</Text>
      </View>

      {records.map((record) => (
        <View className='check-in-list-card' key={record.id}>
          <View className='check-in-list-card__preview'>
            {/* 使用打卡记录中的教材内页，老师可直接确认学生练习的位置。 */}
            <Image
              className='check-in-list-card__image'
              src={record.imageUrl}
              mode='aspectFit'
              webp
              lazyLoad
            />
          </View>
          <View className='check-in-list-card__content'>
            <Text className='check-in-list-card__section'>{record.sectionTitle}</Text>
            <Text className='check-in-list-card__book'>{record.bookTitle}</Text>
            <Text className='check-in-list-card__meta'>
              第 {record.pageNumber} 页 · {formatCheckInTime(record.createdAt)} · {formatRecordingDuration(record.durationMs)}
            </Text>
            <View className='check-in-list-card__actions'>
              <Button className='check-in-list-card__open' onClick={() => openRecord(record)}>回听与分享</Button>
              <Button className='check-in-list-card__delete' onClick={() => deleteRecord(record)}>删除</Button>
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}
