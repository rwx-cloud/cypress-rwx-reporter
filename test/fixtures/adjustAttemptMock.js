
module.exports = function adjustAttempt(attempt, test, kind, error, context) {
	attempt.meta = attempt.meta || {};
	attempt.meta.html = `fromAdjustAttempt-${test.title}-${kind}-${error.message}-${context?.attemptNumber}`;
};
