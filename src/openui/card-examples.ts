// One or more realistic openui blocks per bos bot 3.0 card, for the card
// gallery and the tests (cards.test.ts parses every one with the v3 parser).
// Malaysian small-business flavour: a bridal studio, a car workshop, a
// bakery, a tuition centre. Server-safe: strings only.
import type { CardName } from "../../shared/card-guide";

export interface CardExample { name: CardName; title: string; code: string }

export const CARD_EXAMPLES: CardExample[] = [
  {
    name: "Person",
    title: "A hot lead from an instagram ad",
    code: `root = Col([lead])
lead = Person("Aina Rahman", "Seri Bridal · from instagram ad", "hot", {phone: "+60 12-345 6789", budget: "RM 4,200", wedding: "14 dec 2026", asked: "today 10:14"}, [call, reply])
call = Button("call her", @ToAssistant("call aina rahman"), "outline")
reply = Button("draft a reply", @ToAssistant("draft a whatsapp reply to aina about the december package"))`,
  },
  {
    name: "Person",
    title: "Three leads to chase",
    code: `root = Col([Grid([a, b, c], 3, 220)])
a = Person("Hafiz Azman", "Proton X50 · brake noise", "new", {phone: "+60 17-882 1043", car: "WXY 4821"})
b = Person("Mei Ling Tan", "Honda City · 40k km service", "quoted", {quote: "RM 680", sent: "yesterday"})
c = Person("Ravi Kumar", "Myvi · aircon not cold", "won", {booked: "sat 9:30am", deposit: "RM 100"})`,
  },
  {
    name: "Approval",
    title: "Go-ahead before replying to a lead",
    code: `root = Col([ok])
ok = Approval("Reply to Aina now?", "She asked about the december package.", ["send the price list", "offer a call on thursday"], "yes, send aina the reply")`,
  },
  {
    name: "Approval",
    title: "Pay a supplier",
    code: `root = Col([pay])
pay = Approval("Pay Kedai Alat Ganti Seng Huat RM 1,860?", "Invoice SH-2291 for brake pads and filters, due friday.", ["transfer from Maybank business", "mark the invoice paid in the sheet"], "yes, pay seng huat", "no, hold the payment", "pay RM 1,860")`,
  },
  {
    name: "Choices",
    title: "Pick a fitting slot",
    code: `root = Col([slot])
slot = Choices("Which fitting slot should I offer Aina?", ["sat 2 nov, 11am", "sun 3 nov, 3pm", "wed 6 nov, 7pm"])`,
  },
  {
    name: "Choices",
    title: "Several add-ons at once",
    code: `root = Col([extras])
extras = Choices("Which add-ons go into the december package quote?", ["second outfit", "henna night makeup", "pelamin flowers", "photo album 30 pages"], true)`,
  },
  {
    name: "Steps",
    title: "Month-end close in progress",
    code: `root = Col([close])
close = Steps("October month-end", [{label: "pull sales from the POS", status: "done", detail: "RM 48,320 across 412 orders"}, {label: "match bank deposits", status: "done"}, {label: "chase 3 unpaid invoices", status: "doing", detail: "2 of 3 replied"}, {label: "send the P&L to Encik Zul", status: "todo"}])`,
  },
  {
    name: "Steps",
    title: "A step that failed",
    code: `root = Col([post])
post = Steps("Posting the raya promo", [{label: "write the caption", status: "done"}, {label: "resize the poster for stories", status: "done"}, {label: "post to facebook page", status: "failed", detail: "the page token expired, reconnect facebook"}, {label: "post to instagram", status: "todo"}])`,
  },
  {
    name: "Receipt",
    title: "Workshop invoice with SST",
    code: `root = Col([inv])
inv = Receipt("Invoice INV-0418 · Ravi Kumar", [{label: "aircon gas top-up", amount: 180}, {label: "cabin filter", qty: 1, amount: 45}, {label: "labour (hours)", qty: 2, amount: 60}], "RM", "sent", "Bengkel Jaya Motor · due 31 oct", 8)`,
  },
  {
    name: "Receipt",
    title: "Bakery order, paid",
    code: `root = Col([order])
order = Receipt("Order #2214 · Puan Salmah", [{label: "kek lapis sarawak", qty: 2, amount: 85}, {label: "kuih raya box (50 pcs)", qty: 3, amount: 48}], "RM", "paid", "Dapur Kak Nab · pickup fri 4pm")`,
  },
  {
    name: "Schedule",
    title: "A weekly report, proposed",
    code: `root = Col([weekly])
weekly = Schedule("Monday sales summary", "every monday, 9am", "Kak Nab Ops", "Last week: RM 6,480 from 92 orders, top item kek lapis (31). 4 orders still unpaid, RM 412.")`,
  },
  {
    name: "Schedule",
    title: "A reminder that is already on",
    code: `root = Col([remind])
remind = Schedule("Service reminders to customers due this week", "daily, 10am", "Jaya Motor Bot", "Hi Encik Hafiz, your Proton X50 is due for its 20k km service. Reply YA to book.", true)`,
  },
  {
    name: "SettingChange",
    title: "Change reply hours",
    code: `root = Col([hours])
hours = SettingChange("WhatsApp auto-reply hours", "9am to 6pm", "8am to 10pm", "Seri Bridal · all chats")`,
  },
  {
    name: "FilePreview",
    title: "A price list page",
    code: `root = Col([page])
page = FilePreview("Seri Bridal december packages", "page", "Three packages from RM 3,200 to RM 6,800, with the add-on prices and a booking form.", "https://seribridal.example.com/december", "made today · 2 min read")`,
  },
  {
    name: "FilePreview",
    title: "A sheet without a link",
    code: `root = Col([sheet])
sheet = FilePreview("october-sales.xlsx", "sheet", "412 orders by day and item, with a totals tab.", "", "38 KB")`,
  },
  {
    name: "Compare",
    title: "Three wedding packages",
    code: `root = Col([pkgs])
pkgs = Compare([{name: "Melati", price: "RM 3,200", outfits: 2, makeup: "akad only", pelamin: "standard"}, {name: "Kenanga", price: "RM 4,500", outfits: 3, makeup: "akad + sanding", pelamin: "premium"}, {name: "Cempaka", price: "RM 6,800", outfits: 4, makeup: "all events", pelamin: "custom"}], ["price", "outfits", "makeup", "pelamin"], "Kenanga")`,
  },
  {
    name: "Compare",
    title: "Two suppliers",
    code: `root = Col([sup])
sup = Compare([{name: "Seng Huat Parts", price: "RM 1,860", delivery: "next day", credit: "30 days"}, {name: "AutoMart KL", price: "RM 1,720", delivery: "3 days", credit: "cash only"}])`,
  },
  {
    name: "Draft",
    title: "A whatsapp reply to a lead",
    code: `root = Col([reply])
reply = Draft("Aina Rahman", "Hi Aina! Thanks for asking about our December package. Kenanga is RM 4,500 and includes 3 outfits, akad + sanding makeup and a premium pelamin. Would a fitting this Saturday at 11am work for you?", "whatsapp")`,
  },
  {
    name: "Draft",
    title: "An email to chase an invoice",
    code: `root = Col([chase])
chase = Draft("accounts@tadikaceria.my", "Dear Puan Rohana,\\n\\nA gentle reminder that invoice INV-0391 for RM 1,250 (tuition, october) was due on 15 october. You can pay to Maybank 5140 1234 5678.\\n\\nThank you,\\nPusat Tuisyen Bestari", "email", "Reminder: invoice INV-0391, RM 1,250", "send the reminder to tadika ceria")`,
  },
  {
    name: "Checkin",
    title: "The end of a morning check-in",
    code: `root = Col([today])
today = Checkin("morning check-in")`,
  },
];
