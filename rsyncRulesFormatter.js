// Description: Formats rsync rules to be in the correct order
// Version: 1.0.0
// Author URI:

function parseRule(rule) {
  const exclude = ! rule.trim().startsWith('!');
  const isDir = rule.trim().endsWith('/');

  rule = rule.trim().replace('!', '');

  const specificity = getRuleSpecificity(rule);

  if (isDir && ! exclude ) { 
    rule = rule + '***';
  }

  rule = (exclude ? '- ' : '+ ') + rule;

  return {
    specificity,
    rule,
  };
}

function getRuleSpecificity(rule) {
  let score = 0;
  const parts = rule.split('/');

  parts.forEach(part => {
    if (part.trim() === '') {
      return;
    }

    if (part.includes('*')) {
      part = part.replace(/\*/g, ''); // Remove all asterisks
      score += part.trim() === '' ? 5 : 10; // If part was only asterisks, add 5, if there were more chars, add 10
    } else {
      score += 20; // No asterisks
    }
  });

  return score;
}

function run(input) {
  const rulesArray = input.trim().split('\n').filter(rule => rule.trim() !== '');
  const rsyncRules = [];

  rulesArray.forEach(rule => {
    rsyncRules.push(parseRule(rule));
  });

  rsyncRules.sort((a, b) => (a.specificity < b.specificity ? 1 : -1));

  const rsyncRulesFormatted = rsyncRules.map(rule => rule.rule);

  return rsyncRulesFormatted.join('\n');
}

module.exports = {
  run,
};
