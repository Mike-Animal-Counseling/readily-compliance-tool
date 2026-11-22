import { pdfGrid, pdfLines, synthPdf } from "./policy-pdf";

export type RerankingCase = {
  split: "development" | "holdout";
  id: string;
  question: string;
  goldParentIds: string[];
  goldEvidence: { parentId: string; quote: string }[];
  exceptionText?: string;
};

type Section = {
  heading: string;
  clauses: string[];
  table?: [string, string][];
};

// Fictional freight facility handbook. Section order is fixed so gold IDs
// identify the same parsed parents every time. Both splits see the entire PDF.
const sections: Section[] = [
  {
    heading: "Visitor badge return",
    clauses: [
      "Guests hand their temporary passes to reception when leaving the site.",
      "If reception is shut, deposit the pass in the locked foyer slot.",
    ],
  },
  {
    heading: "Contractor entry authorization",
    clauses: [
      "A sponsoring employee must approve external repair crews before arrival.",
      "A building key does not constitute clearance to start work.",
    ],
  },
  {
    heading: "Damaged load inspection",
    clauses: [
      "A wet outer carton must be examined by a receiving quality inspector.",
      "Keep the carton in the inspection bay pending the release decision.",
    ],
  },
  {
    heading: "Equipment checkout limits",
    clauses: ["The time below starts when the equipment leaves the tool room."],
    table: [
      ["Item", "Maximum loan"],
      ["Hand scanner", "Two hours"],
      ["Label printer", "One shift"],
      ["Pallet scale", "Thirty minutes"],
    ],
  },
  {
    heading: "Shipment status corrections",
    clauses: [
      "Only the dispatch supervisor may cancel a completed outbound scan.",
      "Except for a drill, the original status stays in the event journal.",
    ],
  },
  {
    heading: "Cleaning chemical storage",
    clauses: [
      "Keep opened detergent bottles in the ventilated service cabinet.",
      "An unlocked supply cart is for materials in current use only.",
    ],
  },
  {
    heading: "Outbound driver wait area",
    clauses: [
      "Drivers waiting for a bay stay in the marked holding lane.",
      "Except when the lane floods, drivers wait in the paved east lot.",
    ],
  },
  {
    heading: "Powered cart battery swap",
    clauses: [
      "Replacement cells go on the insulated trolley before installation.",
      "A mechanic records the removed battery serial on the swap sheet.",
    ],
  },
  {
    heading: "Inbound seal discrepancy",
    clauses: [
      "When an incoming trailer seal differs from the manifest, isolate it.",
      "The yard lead must verify its identity before the doors are opened.",
      "Exception: the fire crew opens it at once if there is smoke or heat.",
    ],
  },
  {
    heading: "Non-food chilled totes",
    clauses: [
      "Unload diagnostic reagent totes into the monitored cold alcove.",
      "The receiving record includes the highest temperature in transit.",
      "A detached probe requires quarantine until quality staff release it.",
    ],
  },
  {
    heading: "Overnight vendor work",
    clauses: [
      "An outside technician cannot work beyond closing without an escort.",
      "Except during a declared evacuation, leave with the nearest warden.",
    ],
  },
  {
    heading: "Records retention schedule",
    clauses: ["Use the schedule for completed records stored in the archive."],
    table: [
      ["Record", "Minimum retention"],
      ["Yard incident photos", "Eighteen months"],
      ["Fleet departure slips", "Ninety days"],
      ["Bridge inspection sheets", "Three years"],
    ],
  },
  {
    heading: "Shipment cancellation during outage",
    clauses: [
      "If the outbound system is down, record voided loads in a paper ledger.",
      "The dispatch clerk backfills the electronic entry after restoration.",
    ],
  },
  {
    heading: "Snow route for leased vehicles",
    clauses: [
      "Hired trucks use the river approach when the ridge road is icy.",
      "Standing water closes the river approach only if above axle height.",
      "Use the station approach if both approaches above are unavailable.",
    ],
  },
  {
    heading: "Product sample custody",
    clauses: [
      "Assign each test specimen a tamper tag at handover to the lab courier.",
      "Both parties sign the same transfer slip before it leaves the depot.",
      "Exception: a specimen with a broken tag stays at the collection point.",
    ],
  },
  {
    heading: "Restricted camera exports",
    clauses: [
      "Only an investigations officer may release loading-yard footage.",
      "The request ticket must record the export scope and recipients.",
    ],
  },
  {
    heading: "After-hours spill cordons",
    clauses: ["Place warning panels at the posting point for the affected area."],
    table: [
      ["Affected area", "Posting point"],
      ["South loading apron", "Ramp entrance"],
      ["Live vehicle lane", "Use both ends"],
      ["Live lane in fog", "Exception: use gate posts"],
      ["Public footpath", "Sidewalk access gate"],
    ],
  },
  {
    heading: "Mobile ramp damage",
    clauses: [
      "Take a portable loading bridge out of service if its locking pin bends.",
      "A red service tag remains attached until a mechanic clears it.",
    ],
  },
  {
    heading: "Portable power pack retirement",
    clauses: [
      "Place a swollen charger pack in a fire-resistant holding box.",
      "An external waste carrier collects retired packs from that enclosure.",
    ],
  },
  {
    heading: "Recovery dispatch without a radio",
    clauses: [
      "If the tow operator cannot transmit, use the blue gate call station.",
      "Use the blue station unless the gate is blocked.",
      "A blocked blue gate routes the operator to the canteen phone.",
    ],
  },
  {
    heading: "Weight station capacity",
    clauses: [
      "Only one tractor unit may stand on the platform at the same time.",
      "Unless lane control is unavailable, use the standby queue lights.",
      "When the lights are offline, a marshal releases trucks one by one.",
    ],
  },
  {
    heading: "Documents after customs rejection",
    clauses: [
      "Retain the refused declarations with the rejected consignment file.",
      "The customs broker must reissue the forms before another submission.",
    ],
  },
  {
    heading: "Reporting a depot injury",
    clauses: [
      "Notify the duty controller before returning an injured worker to duty.",
      "The safety desk receives a signed account before the next shift.",
    ],
  },
  {
    heading: "Personal identifiers in shared records",
    clauses: [
      "Remove staff names from any incident paperwork sent to a customer.",
      "A redacted copy is stored in the controlled exports folder.",
    ],
  },
  {
    heading: "Standard overnight vehicle staging",
    clauses: [
      "Depot-owned trucks stage near the ridge road in ordinary conditions.",
      "The river approach is normally reserved for returning empty trailers.",
    ],
  },
  {
    heading: "Carrier seal replacement",
    clauses: [
      "Record seal numbers before replacing a broken outbound trailer seal.",
      "The shipping clerk adds the replacement number to the manifest.",
    ],
  },
  {
    heading: "Food cold-chain receiving",
    clauses: [
      "Put chilled meal cartons in the food annex during receiving.",
      "If a tray lacks a temperature record, return it to the food carrier.",
    ],
  },
  {
    heading: "Inspection forms and temporary photocopies",
    clauses: [
      "Keep photocopies of the bridge worksheets at the dispatch desk.",
      "Shred temporary photocopies once the signed originals are archived.",
    ],
  },
  {
    heading: "Staff radio equipment loans",
    clauses: [
      "Collect replacement radios from the canteen station during a shift.",
      "The equipment loan period ends before the next shift starts.",
    ],
  },
  {
    heading: "Routine still images of loading lanes",
    clauses: [
      "The customer liaison may share empty bay images for a layout inquiry.",
      "Exported still images must exclude personnel and live vehicle details.",
    ],
  },
];

type GoldQuote = [section: number, quote: string];

function casesFor(split: RerankingCase["split"]) {
  return (id: string, question: string, quotes: GoldQuote[], exceptionText?: string): RerankingCase => {
    const goldEvidence = quotes.map(([section, quote]) => ({ parentId: `p${section}`, quote }));
    return {
      split,
      id,
      question,
      goldParentIds: [...new Set(goldEvidence.map(({ parentId }) => parentId))],
      goldEvidence,
      exceptionText,
    };
  };
}

const dev = casesFor("development");
const heldOut = casesFor("holdout");
const cases = [
  dev("pass-return", "Where should a guest put their pass if nobody is at the front desk?", [
    [1, "If reception is shut, deposit the pass in the locked foyer slot."],
  ]),
  dev("repair-admission", "Can the people fixing our lift start work just because they have a key?", [
    [2, "A building key does not constitute clearance to start work."],
  ]),
  dev("soggy-box", "The shipment arrived with a soaked box. Who should look at it?", [
    [3, "A wet outer carton must be examined by a receiving quality inspector."],
  ]),
  dev("scanner-loan", "How long can I borrow the device we use to read labels by hand?", [
    [4, "Hand scanner | Two hours"],
  ]),
  dev("scan-reversal", "Who is allowed to undo a departure scan that already went through?", [
    [5, "Only the dispatch supervisor may cancel a completed outbound scan."],
  ]),
  dev("open-cleaner", "Where does a half-used bottle of cleaning liquid belong?", [
    [6, "Keep opened detergent bottles in the ventilated service cabinet."],
  ]),
  dev("flooded-queue", "Where does a driver queue if the regular waiting lane is underwater?", [
    [7, "Except when the lane floods, drivers wait in the paved east lot."],
  ], "Except when the lane floods, drivers wait in the paved east lot."),
  dev("battery-change", "What identifier does the mechanic write down when replacing a cart battery?", [
    [8, "A mechanic records the removed battery serial on the swap sheet."],
  ]),
  dev("missing-detergent-ratio", "What is the approved cleaning detergent dilution ratio?", []),

  heldOut("seal-mismatch", "The number on the lock doesn't match the paperwork for an arriving lorry. Can receiving unload it?", [
    [9, "When an incoming trailer seal differs from the manifest, isolate it."],
    [9, "The yard lead must verify its identity before the doors are opened."],
  ]),
  heldOut("smoking-trailer", "An incoming trailer has the wrong seal number and smoke is coming out. Who may get the doors open now?", [
    [9, "Exception: the fire crew opens it at once if there is smoke or heat."],
  ], "Exception: the fire crew opens it at once if there is smoke or heat."),
  heldOut("reagent-probe", "The sensor fell off a box of chilled laboratory chemicals in transit. Can it go straight to stock?", [
    [10, "A detached probe requires quarantine until quality staff release it."],
  ]),
  heldOut("vendor-escort", "A repair vendor needs to stay when we lock up. Can she finish the job alone?", [
    [11, "An outside technician cannot work beyond closing without an escort."],
  ]),
  heldOut("evacuation-vendor", "Should a visiting repair tech wait for their regular escort if an evacuation is called after closing?", [
    [11, "Except during a declared evacuation, leave with the nearest warden."],
  ], "Except during a declared evacuation, leave with the nearest warden."),
  heldOut("archived-bridge-checks", "How long must the archive keep completed forms from checks of the loading bridge?", [
    [12, "Bridge inspection sheets | Three years"],
  ]),
  heldOut("offline-void", "How is a load cancellation captured while the departure software is unavailable?", [
    [13, "If the outbound system is down, record voided loads in a paper ledger."],
    [13, "The dispatch clerk backfills the electronic entry after restoration."],
  ]),
  heldOut("winter-route", "Where should a rented truck enter if the high road is icy and floodwater is above the wheels' hubs on the riverside road?", [
    [14, "Standing water closes the river approach only if above axle height."],
    [14, "Use the station approach if both approaches above are unavailable."],
  ], "Standing water closes the river approach only if above axle height."),
  heldOut("broken-sample-tag", "May the courier take a lab specimen away after discovering the tag has snapped?", [
    [15, "Exception: a specimen with a broken tag stays at the collection point."],
  ], "Exception: a specimen with a broken tag stays at the collection point."),
  heldOut("yard-video", "Who can send out a video clip recorded by the loading yard cameras?", [
    [16, "Only an investigations officer may release loading-yard footage."],
  ]),
  heldOut("fog-barrier", "Where do crews put the spill warning signs when the vehicle lane is fogged in?", [
    [17, "Live lane in fog | Exception: use gate posts"],
  ], "Exception: use gate posts"),
  heldOut("warped-ramp-pin", "可移动装卸坡板的锁销弯了，还能继续装货吗？", [
    [18, "Take a portable loading bridge out of service if its locking pin bends."],
  ]),
  heldOut("bulging-pack", "Where do we put a rechargeable power block that has started to bulge?", [
    [19, "Place a swollen charger pack in a fire-resistant holding box."],
  ]),
  heldOut("blocked-call-station", "The recovery truck operator's radio is dead and the blue gate is blocked. How can they call in?", [
    [20, "A blocked blue gate routes the operator to the canteen phone."],
    [20, "Use the blue station unless the gate is blocked."],
  ], "Use the blue station unless the gate is blocked."),
  heldOut("scale-line", "The truck scale's queue lights have failed. Who lets the next driver move forward?", [
    [21, "When the lights are offline, a marshal releases trucks one by one."],
    [21, "Unless lane control is unavailable, use the standby queue lights."],
  ], "Unless lane control is unavailable, use the standby queue lights."),
  heldOut("refused-declaration", "海关拒了这票货的 customs declaration。再次申报之前谁重做表格？", [
    [22, "The customs broker must reissue the forms before another submission."],
  ]),
  heldOut("incident-and-privacy", "Before someone hurt at the depot goes back to work, who must we tell, and should staff names appear in the customer copy of the incident paperwork?", [
    [23, "Notify the duty controller before returning an injured worker to duty."],
    [24, "Remove staff names from any incident paperwork sent to a customer."],
  ]),
  heldOut("missing-meal-threshold", "What outside temperature in Celsius forces the carrier to reject meal cartons?", []),
  heldOut("missing-customs-appeal", "How many working days does the broker have to appeal a denied customs declaration?", []),
  heldOut("missing-escort-coverage", "Is one vendor escort allowed to accompany three contractors at the same time?", []),
];

function pdf() {
  return synthPdf(sections.map(({ heading, clauses, table }, index) => {
    const section = index + 1;
    const text = pdfLines([
      `Section ${section}. ${heading}`,
      ...clauses.map((clause, offset) => `${section}.${offset + 1} ${clause}`),
    ]);
    return table ? `${text}\n${pdfGrid(table, 650)}` : text;
  }));
}

export const rerankingCorpus = { pdf, cases };
