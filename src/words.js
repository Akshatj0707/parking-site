'use strict';

// Plain-English words for days and lists. The pages and the chat assistant both use them, so they always agree.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

// "Monday to Friday" when the days run in a row, otherwise a plain list.
function describeDays(days) {
  const order = [1, 2, 3, 4, 5, 6, 0]; // weeks start on Monday
  const sorted = order.filter((d) => days.includes(d));
  const at = sorted.map((d) => order.indexOf(d));
  const inARow = sorted.length > 2 && at.every((v, i) => i === 0 || v === at[i - 1] + 1);
  return inARow ? `${DAY_NAMES[sorted[0]]} to ${DAY_NAMES[sorted[sorted.length - 1]]}` : joinNames(sorted.map((d) => DAY_NAMES[d]));
}

// The two kinds of day, in words: { weekday: 'Monday to Friday', weekend: 'Saturday and Sunday' }.
function describeWeek(config) {
  const weekdays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !config.weekendDays.includes(d));
  return { weekday: describeDays(weekdays), weekend: describeDays(config.weekendDays) };
}

module.exports = { DAY_NAMES, joinNames, describeDays, describeWeek };
