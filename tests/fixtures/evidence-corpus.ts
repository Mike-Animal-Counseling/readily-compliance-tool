import { pdfLines, synthPdf } from "./policy-pdf";

// The development questions use sections 1–12. The release holdout uses
// distinct source clauses and independently phrased questions in sections 13–24.
const clauses = [
  ["Visitor passes", "A visitor pass is printed with a silver stripe.", "Silver stripe"],
  ["Night dispatch", "A courier uses the western gate after midnight.", "Western gate"],
  ["Tool census", "An inventory starts on the first Tuesday.", "First Tuesday"],
  ["Glove racks", "Glove racks are marked with yellow tape.", "Yellow tape"],
  ["Workshop lockers", "Lockers have duplicate keys in sealed pouches.", "Sealed pouches"],
  ["Spill drills", "A spill exercise is supervised by the shift lead.", "Shift lead"],
  ["Bridge traffic", "One vehicle may cross the pedestrian bridge at a time.", "Bridge"],
  ["Blue labels", "Dispatch copies have labels with raised dots.", "Raised dots"],
  ["Light meter", "Calibration of a light meter is required every fourteen days.", "Light meter"],
  ["Cold parcels", "Temperature records include the warming time.", "Warming time"],
  ["Entrance clocks", "The warehouse clocks are set to standard time.", "Standard time"],
  ["Return receipts", "A signed return receipt is filed in the top drawer.", "Return receipt"],
  ["Badge inventory", "The badge inventory uses indigo tags.", "Indigo tags"],
  ["Sealed samples", "The sample seal is verified by a second technician.", "Sample seal"],
  ["Stair lighting", "The south staircase retains two spare lamps.", "South staircase"],
  ["Archive index", "Archive accession codes use five digits.", "Accession codes"],
  ["Route manifest", "The route manifest is countersigned by a dispatcher.", "Route manifest"],
  ["Emergency batteries", "Reserve batteries are stored in cabinet seven.", "Reserve batteries"],
  ["Equipment loans", "Loan carts are returned by closing time.", "Loan carts", "Except during flood response, when the duty officer sets the deadline."],
  ["Fixture checks", "Each fixture check is logged every Monday.", "Fixture check", "Unless the site is closed, in which case log the first reopening day."],
  ["Radio inventory", "The radio count includes all charging cradles.", "Charging cradles", "Except leased units, which require a separate count."],
  ["Hazard notices", "Hazard notices are posted at the east panel.", "East panel", "Unless a temporary barrier closes the east panel, post at the north board."],
  ["Work orders", "Printed work orders are archived in the gray folder.", "Gray folder"],
  ["Water gauges", "The water gauge reading is recorded before sunrise.", "Water gauge"],
];

export type EvidenceCase = { question: string; parentId: string; quote: string; exception?: string };

export const development: EvidenceCase[] = clauses.slice(0, 12).flatMap(([, quote, keyword], index) => [
  { question: `Show section ${index + 1}.1`, parentId: `p${index + 1}`, quote },
  { question: `Find the policy about ${keyword.toLowerCase()}.`, parentId: `p${index + 1}`, quote },
]);

const heldOutQuestions = [
  ["What does section 13.1 state?", "Which shade of tags is used for badge inventory?"],
  ["Quote clause 14.1", "Who double-checks a sample seal?"],
  ["Show section 15.1", "How many backup lamps stay in the south staircase?"],
  ["What does section 16.1 state?", "How long are archive accession codes?"],
  ["Quote clause 17.1", "Who provides the second signature on a route manifest?"],
  ["Show section 18.1", "Which cabinet holds reserve batteries?"],
  ["What does section 19.1 state?", "Who establishes the loan carts deadline during flood response?"],
  ["Quote clause 20.1", "When should the fixture check happen if the site is closed on Monday?"],
  ["Show section 21.1", "Do leased radios get included with the charging cradles count?"],
  ["What does section 22.1 state?", "Where are hazard notices posted when a barrier blocks the east panel?"],
  ["Quote clause 23.1", "Where can I find gray folder work orders?"],
  ["What does section 24.1 state?", "When do operators note the water gauge reading?"],
];

export const holdout: EvidenceCase[] = heldOutQuestions.flatMap((questions, offset) => {
  const index = offset + 12;
  const [, quote, , exception] = clauses[index];
  return questions.map(question => ({ question, parentId: `p${index + 1}`, quote, exception }));
});

export function evidenceCorpus() {
  return synthPdf(clauses.map(([heading, quote, , exception], index) => pdfLines([
    `Section ${index + 1}. ${heading}`,
    `${index + 1}.1 ${quote}`,
    ...(exception ? [exception] : []),
  ])));
}
