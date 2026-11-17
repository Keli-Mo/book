import {
  getReminderChoiceDate,
  isReminderTimeInFuture,
  type ReminderSettingsState,
} from "@/features/dailyReminder/reminderSettings";

export const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
export const MINUTES = ["00", "10", "20", "30", "40", "50"];

export const getAvailableMinutes = (date: string, hour: string, now = Date.now()): string[] =>
  MINUTES.filter(minute => isReminderTimeInFuture(date, `${hour}:${minute}`, now));

export const getAvailableHours = (date: string, now = Date.now()): string[] =>
  HOURS.filter(hour => getAvailableMinutes(date, hour, now).length > 0);

export const isReminderDateAvailable = (date: string, now = Date.now()): boolean =>
  (date === getReminderChoiceDate(0, now) || date === getReminderChoiceDate(1, now))
  && isReminderTimeInFuture(date, "23:50", now);

/** Legacy minute preferences remain visible until the user explicitly changes them. */
export function getFutureTimeOnDate(date: string, time: string, now = Date.now()): string | undefined {
  if (!isReminderDateAvailable(date, now)) return undefined;
  if (isReminderTimeInFuture(date, time, now)) return time;
  const hour = getAvailableHours(date, now)[0];
  return `${hour}:${getAvailableMinutes(date, hour, now)[0]}`;
}

export function getInitialReminderDate(settings: ReminderSettingsState, now = Date.now()): string {
  const preferred = settings.selectedDate || settings.nextDate;
  if (preferred && isReminderDateAvailable(preferred, now)
    && isReminderTimeInFuture(preferred, settings.time, now)) return preferred;
  if (settings.nextDate && isReminderDateAvailable(settings.nextDate, now)
    && isReminderTimeInFuture(settings.nextDate, settings.scheduledTime || settings.time, now)) {
    return settings.nextDate;
  }
  const today = getReminderChoiceDate(0, now);
  return isReminderDateAvailable(today, now) && isReminderTimeInFuture(today, settings.time, now)
    ? today : getReminderChoiceDate(1, now);
}
