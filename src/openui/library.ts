// The smart ui component library every bos bot can answer with: a fenced
// ```openui block in a reply renders live in chat. Components and functions
// are vendored from open-intelligent-ui (MIT, see LICENSE) and trimmed to what
// a data answer needs; no maps, photos, video or games. No css here, so the
// prompt generator can load this file outside a browser.
import { createLibrary } from "@openuidev/react-lang";
import { Callout, Stat } from "./components/bos";
import { Chart } from "./components/chart";
import { Button, Checkbox, DatePicker, Input, SegmentedControl, Select } from "./components/controls";
import { Card, Col, Divider, Form, Grid, Row, Spacer } from "./components/layout";
import { Table } from "./components/table";
import { Badge, Caption, Link, List, ListItem, Text, Title } from "./components/text";
import { functions } from "./functions";

export const library = createLibrary({
  root: "Col",
  components: [
    Col, Row, Grid, Card, Divider, Spacer,
    Title, Text, Caption, Badge, Link, List, ListItem, Callout,
    Stat, Table, Chart,
    Button, Input, Select, SegmentedControl, Checkbox, DatePicker, Form,
  ],
  functions,
  componentGroups: [
    { name: "Layout", components: ["Col", "Row", "Grid", "Card", "Divider", "Spacer"] },
    { name: "Text", components: ["Title", "Text", "Caption", "Badge", "Link", "List", "ListItem", "Callout"] },
    { name: "Data", components: ["Stat", "Table", "Chart"] },
    { name: "Inputs", components: ["Button", "Input", "Select", "SegmentedControl", "Checkbox", "DatePicker", "Form"] },
  ],
});
