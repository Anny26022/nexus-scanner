// One sizing policy for native tables, including the widths used by windowing.
const policies = {
  screener: {
    phoneOrder:['company','close','changePct'],
    phoneWidths:{company:176,close:100,changePct:88,sector:180},
    desktopWidths:{company:240,sector:180}, fallback:150, minimum:1120,
    defaultWidths:{} as Record<string,string>,
  },
  ipo: {
    phoneOrder:['company','currentPrice','listingDate'],
    phoneWidths:{company:176,currentPrice:110},
    desktopWidths:{company:240,sectorIndustry:190}, fallback:170, minimum:1080,
    defaultWidths:{company:'26%',sectorIndustry:'17%',deliveryPct:'9%',other:'12%'},
  },
};

export function tableLayout<T extends {id:string; width?:string}>(columns:T[], kind:keyof typeof policies, phone:boolean, custom:boolean) {
  const policy = policies[kind];
  const priority = (id:string) => {
    const index = policy.phoneOrder.indexOf(id);
    return index < 0 ? policy.phoneOrder.length : index;
  };
  const ordered = phone ? [...columns].sort((a,b) => priority(a.id) - priority(b.id)) : columns;
  const widths:Record<string,number> = phone ? policy.phoneWidths : policy.desktopWidths;
  const widthOf = (column:T) => widths[column.id] ?? (phone ? 150 : policy.fallback);
  const fixed = phone || custom;
  const minimum = fixed ? Math.max(phone ? 0 : 1120, ordered.reduce((sum,column) => sum + widthOf(column), 0)) : policy.minimum;
  const defaultWidths:Record<string,string> = policy.defaultWidths;
  return {
    columns:ordered, widthOf,
    style:{width:!phone && custom ? `${minimum}px` : '100%', minWidth:`${minimum}px`},
    columnWidth:(column:T) => fixed ? `${widthOf(column)}px` : column.width ?? defaultWidths[column.id] ?? defaultWidths.other,
  };
}
