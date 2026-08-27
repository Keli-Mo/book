export const formatRecordingDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
};

export const formatCheckInTime = (rawValue: unknown) => {
  // 云数据库日期在真机、开发者工具和云函数返回中可能是 Date、字符串或 {$date}。
  const value =
    rawValue && typeof rawValue === "object" && "$date" in rawValue
      ? (rawValue as { $date: string | number }).$date
      : (rawValue as string | number | Date);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚完成";

  const pad = (item: number) => String(item).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
