export function historyDayKey(timestamp: number, startMinutes: number): string {
  const local = new Date(timestamp);
  const boundary = Math.max(0, Math.min(1439, Math.floor(startMinutes)));
  const minutesSinceMidnight = local.getHours() * 60 + local.getMinutes();
  const dayDate = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  if (minutesSinceMidnight < boundary) dayDate.setDate(dayDate.getDate() - 1);
  const year = dayDate.getFullYear();
  const month = String(dayDate.getMonth() + 1).padStart(2, "0");
  const day = String(dayDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
