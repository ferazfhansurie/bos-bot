/** Every module that registers a workbench tab kind, imported once by the
 * dock. Built-ins first, so a later module registering the same kind (the
 * pages editor replacing the "page" placeholder) wins. One line per module. */
import "@/components/workbench/builtins";

import "@/components/pages/register";
import "@/components/videos/register";
import "@/components/canvas/register";
