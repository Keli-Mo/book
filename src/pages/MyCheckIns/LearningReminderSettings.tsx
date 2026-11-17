import { Button, Text, View } from "@tarojs/components";
import Taro, { useDidShow } from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import AppIcon from "@/components/AppIcon/AppIcon";
import {
  currentChinaDayKey,
  discardPendingReminderRegistrations,
  isWechatReminderConfigured,
  requestTomorrowSubscription,
  subscribeNextFromHome,
} from "@/features/dailyReminder/wechatSubscription";
import {
  canReuseNextSettingsReservation,
  getReminderChoiceDate,
  getReminderSettings,
  isReminderTimeInFuture,
  readCachedReminderSettings,
  setReminderSettings,
  type ReminderSettingsState,
} from "@/features/dailyReminder/reminderSettings";
import { restoreReminderSettings } from "@/features/dailyReminder/restoreReminderSettings";
import SilentTimeWheel from "./SilentTimeWheel";
import {
  HOURS, MINUTES, getAvailableMinutes, getFutureTimeOnDate,
  getInitialReminderDate, isReminderDateAvailable,
} from "./reminderTimeChoices";

const TIME_FIELDS = [
  { key: "hour", label: "小时", options: HOURS },
  { key: "minute", label: "分钟", options: MINUTES },
] as const;

type ReminderDraft = {
  hour: string;
  minute: string;
  today: string;
  tomorrow: string;
  targetDate: string;
  hourMoving: boolean;
  minuteMoving: boolean;
};

const reminderErrors: Record<string, string> = {
  INVALID_TARGET_DATE: "日期已变，请重新选择",
  REMINDER_TIME_PASSED: "所选时间已过，请改时间或选明天",
  REMINDER_IN_PROGRESS: "提醒正在发送，请稍后再试",
  RESERVATION_CHANGED: "预约已变更，请重新确认",
};

function activeDateChoice(settings: ReminderSettingsState, now = Date.now()): string | undefined {
  const date = settings.selectedDate;
  if ((date === getReminderChoiceDate(0, now) || date === getReminderChoiceDate(1, now))
    && isReminderTimeInFuture(date, settings.time, now)) return date;
  return undefined;
}

function hasReservationOn(settings: ReminderSettingsState, date: string): boolean {
  return settings.enabled && settings.nextStatus === "scheduled"
    && (settings.nextDate === date || settings.tomorrowScheduledDate === date);
}

function reservationStatus(settings: ReminderSettingsState, selectedDate?: string): string {
  if (!settings.enabled) return "已关闭";
  if (selectedDate && !hasReservationOn(settings, selectedDate)) {
    const day = selectedDate === getReminderChoiceDate(0) ? "今天" : "明天";
    return `${day} ${settings.time} 待预约`;
  }
  if (settings.nextStatus !== "scheduled") return "下一次提醒待预约";
  const date = settings.nextDate;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "下一条已预约";
  const dateLabel = `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
  const alsoTomorrow = settings.tomorrowScheduledDate && settings.tomorrowScheduledDate !== date;
  return `${dateLabel} ${settings.scheduledTime || settings.time} 已预约${alsoTomorrow ? " · 明天也已预约" : ""}`;
}

export default function LearningReminderSettings() {
  const [expanded, setExpanded] = useState(false);
  const [reminderSettings, setReminderSettingsState] = useState<ReminderSettingsState>(readCachedReminderSettings);
  const [accountVerified, setAccountVerified] = useState(false);
  const [savingReminder, setSavingReminder] = useState(false);
  const [draft, setDraft] = useState<ReminderDraft | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const draftRef = useRef<ReminderDraft | null>(null);
  const reminderActionRef = useRef(false);
  const reminderRevisionRef = useRef(0);

  useDidShow(() => {
    const revision = reminderRevisionRef.current;
    void restoreReminderSettings().then(result => {
      if (revision !== reminderRevisionRef.current || reminderActionRef.current) return;
      if (result.ok && result.settings) {
        setAccountVerified(true);
        setReminderSettingsState(result.settings);
      } else if (result.reason === "TEST_ACCOUNT_REQUIRED") {
        setAccountVerified(false);
        setExpanded(false);
      }
    });
  });

  const refreshReminderSettings = async () => {
    const result = await getReminderSettings();
    if (result.ok && result.settings) setReminderSettingsState(result.settings);
  };

  const updateDraft = (value: ReminderDraft | null) => {
    draftRef.current = value;
    setDraft(value);
  };

  const editDraft = (fields: Partial<ReminderDraft>) => {
    if (draftRef.current) updateDraft({ ...draftRef.current, ...fields });
  };

  const refreshDraft = (current: ReminderDraft, now: number): ReminderDraft => {
    const today = getReminderChoiceDate(0, now);
    const tomorrow = getReminderChoiceDate(1, now);
    const targetDate = isReminderDateAvailable(current.targetDate, now) ? current.targetDate
      : isReminderDateAvailable(today, now) ? today : tomorrow;
    const time = getFutureTimeOnDate(targetDate, `${current.hour}:${current.minute}`, now)!;
    const [hour, minute] = time.split(":");
    return { ...current, today, tomorrow, targetDate, hour, minute };
  };

  useEffect(() => {
    if (!draft) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      setClockNow(now);
      const current = draftRef.current;
      if (current) updateDraft(refreshDraft(current, now));
      timer = setTimeout(tick, 60000 - Date.now() % 60000 + 20);
    };
    timer = setTimeout(tick, 60000 - Date.now() % 60000 + 20);
    return () => clearTimeout(timer);
  }, [Boolean(draft)]);

  const chooseDate = (targetDate: string) => {
    const now = Date.now();
    if (!draftRef.current || !isReminderDateAvailable(targetDate, now)) return;
    setClockNow(now);
    updateDraft(refreshDraft({ ...draftRef.current, targetDate }, now));
  };

  const isTimeOptionDisabled = (field: "hour" | "minute", value: string): boolean => {
    const current = draftRef.current;
    if (!current || !isReminderDateAvailable(current.targetDate)) return true;
    return field === "hour" ? getAvailableMinutes(current.targetDate, value).length === 0
      : !getAvailableMinutes(current.targetDate, current.hour).includes(value);
  };

  const chooseTime = (field: "hour" | "minute", value: string) => {
    const current = draftRef.current;
    if (!current || isTimeOptionDisabled(field, value)) return;
    const now = Date.now();
    setClockNow(now);
    updateDraft(refreshDraft({ ...current, [field]: value }, now));
  };

  const saveReminder = async (enabled: boolean, time: string, targetDate?: string) => {
    if (reminderActionRef.current) return;
    if (enabled && targetDate && !isReminderTimeInFuture(targetDate, time)) {
      Taro.showToast({ title: reminderErrors.REMINDER_TIME_PASSED, icon: "none" });
      return;
    }
    reminderActionRef.current = true;
    reminderRevisionRef.current += 1;
    setSavingReminder(true);
    try {
      // 微信授权须在开关或确认按钮的点击回调内发起。
      const requestChinaDate = currentChinaDayKey();
      const request = enabled && !canReuseNextSettingsReservation(reminderSettings, time, Date.now(), targetDate)
        ? requestTomorrowSubscription(true) : null;
      const [decision, saved] = await Promise.all([request, setReminderSettings(enabled, time, targetDate)]);
      if (!saved.ok || !saved.settings) {
        Taro.showToast({ title: reminderErrors[saved.reason || ""] || "提醒设置失败，请稍后重试", icon: "none" });
        if (saved.reason === "RESERVATION_CHANGED" || saved.reason === "REMINDER_IN_PROGRESS") {
          await refreshReminderSettings();
        }
        return;
      }
      setReminderSettingsState(saved.settings);
      updateDraft(null);
      if (!enabled) {
        discardPendingReminderRegistrations();
        return;
      }
      const alreadyReserved = targetDate ? hasReservationOn(saved.settings, targetDate)
        : canReuseNextSettingsReservation(saved.settings, time);
      if (alreadyReserved) return;
      if (decision?.status === "accepted") {
        const registration = await subscribeNextFromHome(
          decision, requestChinaDate, saved.settings.time, targetDate,
        );
        if (!registration.nextScheduled) {
          Taro.showToast({ title: reminderErrors[registration.reason || ""] || "计划已开启，下一条待预约", icon: "none" });
        }
        await refreshReminderSettings();
      } else if (request) {
        Taro.showToast({ title: "计划已开启，微信提醒待授权", icon: "none" });
      } else {
        Taro.showToast({ title: "下一条待预约，请重新确认时间", icon: "none" });
      }
    } finally {
      reminderActionRef.current = false;
      setSavingReminder(false);
    }
  };

  const openTimeEditor = () => {
    const now = Date.now();
    const [hour, minute] = reminderSettings.time.split(":");
    setClockNow(now);
    updateDraft(refreshDraft({
      hour, minute,
      today: getReminderChoiceDate(0, now),
      tomorrow: getReminderChoiceDate(1, now),
      targetDate: getInitialReminderDate(reminderSettings, now),
      hourMoving: false,
      minuteMoving: false,
    }, now));
  };

  const confirmTime = (enabled: boolean) => {
    const current = draftRef.current;
    if (!current || current.hourMoving || current.minuteMoving || !MINUTES.includes(current.minute)) return;
    const now = Date.now();
    if (current.today !== getReminderChoiceDate(0, now)
      || !isReminderDateAvailable(current.targetDate, now)
      || !isReminderTimeInFuture(current.targetDate, `${current.hour}:${current.minute}`, now)) {
      setClockNow(now);
      updateDraft(refreshDraft(current, now));
      Taro.showToast({ title: "时间已更新，请重新确认", icon: "none" });
      return;
    }
    void saveReminder(enabled, `${current.hour}:${current.minute}`, current.targetDate);
  };

  const selectedDate = activeDateChoice(reminderSettings);
  const displayDate = reminderSettings.nextStatus === "scheduled" ? reminderSettings.nextDate : selectedDate;
  const displayTime = reminderSettings.nextStatus === "scheduled"
    ? reminderSettings.scheduledTime || reminderSettings.time : reminderSettings.time;
  const selectedDayLabel = displayDate ? (displayDate === getReminderChoiceDate(0) ? "今天" : "明天") : "";
  const todayAvailable = !draft || isReminderDateAvailable(draft.today, clockNow);

  if (!accountVerified || !isWechatReminderConfigured()) return null;

  return (
    <View className='daily-reminder-card'>
      <Button
        className='daily-reminder-card__disclosure'
        hoverClass='daily-reminder-card__disclosure--pressed'
        ariaLabel={expanded ? "收起学习提醒设置" : "展开学习提醒设置"}
        onClick={() => { updateDraft(null); setExpanded(value => !value); }}
      >
        <Text className='daily-reminder-card__title'>学习提醒</Text>
        {!expanded && (
          <Text className='daily-reminder-card__summary'>
            {reminderSettings.enabled ? displayTime : "已关闭"}
          </Text>
        )}
        <AppIcon value={expanded ? "chevron-down" : "chevron-right"} size='15' color='#71827b' />
      </Button>
      {expanded && (
        <View className='daily-reminder-card__panel'>
          <View className='daily-reminder-card__row'>
            <Text>微信提醒</Text>
            <Button
              className={`daily-reminder-card__switch${reminderSettings.enabled ? " daily-reminder-card__switch--on" : ""}`}
              ariaLabel={`微信学习提醒，${reminderSettings.enabled ? "已开启" : "已关闭"}`}
              disabled={savingReminder || (!reminderSettings.enabled && Boolean(draft?.hourMoving || draft?.minuteMoving))}
              onClick={() => {
                if (!reminderSettings.enabled) {
                  if (draftRef.current) {
                    if (!MINUTES.includes(draftRef.current.minute)) {
                      Taro.showToast({ title: "请先选择分钟", icon: "none" });
                    } else confirmTime(true);
                    return;
                  }
                  if (!MINUTES.includes(reminderSettings.time.split(":")[1])) {
                    openTimeEditor();
                    return;
                  }
                }
                const targetDate = reminderSettings.enabled ? activeDateChoice(reminderSettings)
                  : getInitialReminderDate(reminderSettings);
                void saveReminder(!reminderSettings.enabled, reminderSettings.time, targetDate);
              }}
            >
              <View className='daily-reminder-card__switch-track'>
                <View className='daily-reminder-card__switch-thumb' />
              </View>
            </Button>
          </View>
          <Button
            className='daily-reminder-card__row daily-reminder-card__time-trigger'
            disabled={savingReminder}
            ariaLabel={`调整提醒日期和时间，${selectedDayLabel} ${displayTime}`}
            onClick={() => draftRef.current ? updateDraft(null) : openTimeEditor()}
          >
            <Text>提醒日期与时间</Text>
            <View className='daily-reminder-card__time'>
              <Text>{selectedDayLabel && `${selectedDayLabel} `}{displayTime}</Text>
              <AppIcon value='chevron-down' size='13' color='#5c796e' />
            </View>
          </Button>
          {draft && (
            <View className='daily-reminder-card__time-editor'>
              <View className='daily-reminder-card__days'>
                {[
                  { key: "today", label: "今天", date: draft.today },
                  { key: "tomorrow", label: "明天", date: draft.tomorrow },
                ].map(option => (
                  <Button
                    key={option.key}
                    className={`daily-reminder-card__day daily-reminder-card__day--${option.key}${option.date === draft.targetDate ? " daily-reminder-card__day--active" : ""}`}
                    ariaLabel={`${option.label}${option.key === "today" && !todayAvailable ? "，已无可选时间" : option.date === draft.targetDate ? "，已选" : ""}`}
                    disabled={savingReminder || (option.key === "today" && !todayAvailable)}
                    onClick={() => chooseDate(option.date)}
                  >{option.label}</Button>
                ))}
              </View>
              {!MINUTES.includes(draft.minute) && (
                <Text className='daily-reminder-card__field-label'>原为 {draft.minute} 分，请选择新的分钟</Text>
              )}
              <View className='daily-reminder-card__wheels'>
                {TIME_FIELDS.map(field => (
                  <View key={field.key} className='daily-reminder-card__wheel-column'>
                    <Text className='daily-reminder-card__field-label'>{field.label}</Text>
                    <SilentTimeWheel
                      field={field.key}
                      label={field.label}
                      options={field.options}
                      value={draft[field.key]}
                      disabled={savingReminder}
                      isOptionDisabled={value => isTimeOptionDisabled(field.key, value)}
                      onChange={value => chooseTime(field.key, value)}
                      onMovingChange={moving => editDraft({ [`${field.key}Moving`]: moving })}
                    />
                  </View>
                ))}
              </View>
              <View className='daily-reminder-card__time-actions'>
                <Button
                  className='daily-reminder-card__time-cancel'
                  disabled={savingReminder}
                  onClick={() => updateDraft(null)}
                >取消</Button>
                <Button
                  className='daily-reminder-card__time-confirm'
                  disabled={savingReminder || draft.hourMoving || draft.minuteMoving || !MINUTES.includes(draft.minute)}
                  onClick={() => confirmTime(reminderSettings.enabled)}
                >确定</Button>
              </View>
            </View>
          )}
          <Text className={`daily-reminder-card__status daily-reminder-card__status--${reminderSettings.nextStatus}`}>
            {savingReminder ? "设置中" : reservationStatus(reminderSettings, selectedDate)}
          </Text>
        </View>
      )}
    </View>
  );
}
