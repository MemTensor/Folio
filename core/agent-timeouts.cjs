const BUDGETS = Object.freeze({
  none: 180000,
  minimal: 180000,
  low: 180000,
  medium: 360000,
  high: 600000,
  xhigh: 900000,
  max: 900000,
  ultra: 900000,
});
function activityTimeout(effort, override) {
  return Number.isFinite(override) && override > 0 ? override : BUDGETS[effort] || BUDGETS.medium;
}
module.exports = { activityTimeout };
