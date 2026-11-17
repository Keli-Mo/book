import { getReminderSettings } from "./reminderSettings";
import {
  retryPendingHomeReminder,
  retryPendingLearningStartReminder,
  retryPendingTomorrowReminder,
} from "./wechatSubscription";

export async function restoreReminderSettings() {
  const settings = await getReminderSettings();
  if (!settings.ok) return settings;
  const retried = await Promise.all([
    retryPendingHomeReminder(),
    retryPendingLearningStartReminder(),
    retryPendingTomorrowReminder(),
  ]);
  return retried.some(Boolean) ? getReminderSettings() : settings;
}
