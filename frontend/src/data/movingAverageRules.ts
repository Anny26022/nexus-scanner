export const MOVING_AVERAGE_RULES = ['EMA', 'SMA'].flatMap(type =>
  [10, 20, 21, 50, 150, 200].flatMap(period => ['ABOVE', 'BELOW'].map(side => ({
    value: `${side}_${type}_${period}`,
    label: `${side === 'ABOVE' ? 'Above' : 'Below'} ${period} ${type}`,
    field: `${type.toLowerCase()}${period}`,
    above: side === 'ABOVE',
  }))));
