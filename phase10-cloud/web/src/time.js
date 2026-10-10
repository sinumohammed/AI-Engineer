// Phase 10 UI: message timestamps, in the device's own language and clock
// (12- or 24-hour, as the phone or computer is set).
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const dayYearFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export const shortTime = (at) => timeFmt.format(at);
export const fullTime = (at) => fullFmt.format(at);

const startOfDay = (at) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const sameDay = (a, b) => startOfDay(a) === startOfDay(b);

// "Today", "Yesterday", "Fri, 8 Oct", or with the year when it is not this year.
export function dayLabel(at) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).getFullYear() === new Date().getFullYear() ? dayFmt.format(at) : dayYearFmt.format(at);
}
