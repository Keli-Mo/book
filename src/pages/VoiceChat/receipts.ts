import { confirmVoiceChatTurn, type VoiceChatReceipt } from "@/services/voiceChat";

/** Only player.onPlay moves a receipt into the confirmation queue. */
export function createVoiceChatReceipts(refreshQuota: () => void) {
  type Entry = { receipt: VoiceChatReceipt; played: boolean; sending: boolean };
  const entries = new Map<string, Entry>();
  const confirm = async (entry: Entry, retry: boolean) => {
    if (entry.sending || !entries.has(entry.receipt.requestId)) return;
    entry.sending = true;
    try {
      await confirmVoiceChatTurn(entry.receipt);
      entries.delete(entry.receipt.requestId);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "RESERVATION_EXPIRED" || code === "INVALID_RECEIPT") {
        entries.delete(entry.receipt.requestId);
      } else if (retry) {
        setTimeout(() => { void confirm(entry, false); }, 800);
      }
    } finally {
      entry.sending = false;
      refreshQuota();
    }
  };
  return {
    add(receipt: VoiceChatReceipt) {
      if (!entries.has(receipt.requestId)) entries.set(receipt.requestId, { receipt, played: false, sending: false });
    },
    isUnplayed(requestId: string) {
      return entries.get(requestId)?.played === false;
    },
    playbackStarted(requestId: string) {
      const entry = entries.get(requestId);
      if (!entry) return;
      entry.played = true;
      void confirm(entry, true);
    },
    retryPlayed() {
      for (const entry of entries.values()) if (entry.played) void confirm(entry, true);
    },
  };
}
