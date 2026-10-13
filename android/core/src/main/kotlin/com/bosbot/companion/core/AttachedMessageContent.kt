package com.openmausbot.companion.core

/** A safe, quiet label for an attachment encoded in a stored user prompt. */
data class DisplayedMessageAttachment(
    val kind: Kind,
    val name: String,
    /** The computer-local path carried by the exact standalone transport tag. */
    val path: String,
) {
    enum class Kind { IMAGE, FILE }
}

data class AttachedMessageContent(
    val text: String,
    val attachments: List<DisplayedMessageAttachment>,
) {
    companion object {
        /** Split only exact standalone tags; inline examples remain ordinary prose. */
        fun parse(source: String, markdownImages: Boolean = false): AttachedMessageContent {
            val attachments = mutableListOf<DisplayedMessageAttachment>()
            val seenImagePaths = mutableSetOf<String>()
            val visible = StringBuilder()
            var fence: Fence? = null
            var htmlBlock: HtmlBlock? = null
            var cursor = 0
            while (cursor < source.length) {
                val newline = source.indexOf('\n', cursor)
                val lineEnd = if (newline >= 0) newline else source.length
                val wholeLineEnd = if (newline >= 0) newline + 1 else source.length
                val rawLine = source.substring(cursor, lineEnd)
                val line = rawLine.removeSuffix("\r")
                var consumedTransportTag = false

                val marker = fenceMarker(line)
                val activeFence = fence
                if (activeFence != null) {
                    if (
                        marker != null && marker.character == activeFence.character &&
                        marker.length >= activeFence.length && marker.remainder.all { it == ' ' || it == '\t' }
                    ) {
                        fence = null
                    }
                } else if (htmlBlock != null) {
                    val activeHTMLBlock = htmlBlock!!
                    val shouldEnd = activeHTMLBlock.closingToken
                        ?.let { it in line.lowercase() }
                        ?: line.all { it == ' ' || it == '\t' }
                    if (shouldEnd) {
                        htmlBlock = null
                    }
                } else if (marker != null) {
                    fence = Fence(marker.character, marker.length)
                } else {
                    val match = TAG.matchEntire(line)
                    if (match != null) {
                        val kind = if (match.groupValues[1] == "image") {
                            DisplayedMessageAttachment.Kind.IMAGE
                        } else {
                            DisplayedMessageAttachment.Kind.FILE
                        }
                        val path = decodeAttribute(match.groupValues[2])
                        val provided = match.groups[3]?.value?.let(::decodeAttribute)
                        if (!markdownImages || kind != DisplayedMessageAttachment.Kind.IMAGE || seenImagePaths.add(imageIdentity(path))) {
                            attachments += DisplayedMessageAttachment(kind, displayName(provided, path, kind), path)
                        }
                        consumedTransportTag = true
                    } else {
                        val images = if (markdownImages) localMarkdownImages(line) else null
                        if (images != null) {
                            images.filter { seenImagePaths.add(imageIdentity(it.path)) }.forEach { attachments += it }
                            consumedTransportTag = true
                        } else htmlBlock = htmlBlockStarting(line)
                    }
                }

                if (!consumedTransportTag) visible.append(source, cursor, wholeLineEnd)
                cursor = wholeLineEnd
            }
            return AttachedMessageContent(
                text = visible.toString().trim(),
                attachments = attachments,
            )
        }

        private val MARKDOWN_IMAGE_PATTERN = """!\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^\s()<>]+))(?:[\t ]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[\t ]*\)"""
        private val MARKDOWN_IMAGE = Regex(MARKDOWN_IMAGE_PATTERN)
        private val MARKDOWN_IMAGE_LINE = run {
            val image = "(?:\\[[\\t ]*$MARKDOWN_IMAGE_PATTERN[\\t ]*\\]\\([^()\\r\\n]*\\)|$MARKDOWN_IMAGE_PATTERN)"
            Regex("^ {0,3}(?:(?:[-*+]|\\d{1,9}[.)])[\\t ]+)?$image(?:[\\t ]+$image)*[\\t ]*$")
        }
        private fun localImagePath(path: String): String? {
            if (path.startsWith("file:", ignoreCase = true)) return (LocalMessageLink.resolve(path) as? LocalMessageLink.DesktopFile)?.path
            if (!(path.startsWith('/') && !path.startsWith("//")) && !Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(path)) return null
            return runCatching { java.net.URLDecoder.decode(path.replace("+", "%2B"), "UTF-8") }.getOrNull()
        }
        private fun imageIdentity(path: String): String = localImagePath(path) ?: path
        private fun localMarkdownImages(line: String): List<DisplayedMessageAttachment>? {
            if (!MARKDOWN_IMAGE_LINE.matches(line)) return null
            val images = mutableListOf<DisplayedMessageAttachment>()
            MARKDOWN_IMAGE.findAll(line).forEach { match ->
                val path = match.groups[1]?.value ?: match.groups[2]?.value ?: return null
                val local = localImagePath(path) ?: return null
                images += DisplayedMessageAttachment(DisplayedMessageAttachment.Kind.IMAGE,
                    displayName(null, local, DisplayedMessageAttachment.Kind.IMAGE), path)
            }
            return images.takeIf { it.isNotEmpty() }
        }

        private data class Fence(val character: Char, val length: Int)
        private data class FenceMarker(val character: Char, val length: Int, val remainder: String)
        /** A null token is a CommonMark type 6/7 block, which ends at a blank line. */
        private data class HtmlBlock(val closingToken: String?)

        private fun htmlBlockStarting(line: String): HtmlBlock? {
            val lower = line.lowercase()
            val comment = lower.indexOf("<!--")
            if (comment >= 0 && lower.indexOf("-->", comment + 4) < 0) return HtmlBlock("-->")

            val content = commonMarkContent(line) ?: return null
            val lowerContent = content.lowercase()

            if (PASTED_TEXT_START.containsMatchIn(line)) {
                return if ("</pasted-text>" in lowerContent) null else HtmlBlock("</pasted-text>")
            }

            val typeOne = TYPE_ONE.find(line)
            if (typeOne != null) {
                val closingToken = "</${typeOne.groupValues[1].lowercase()}>"
                return if (closingToken in lower) null else HtmlBlock(closingToken)
            }

            if (lowerContent.startsWith("<?")) {
                return if ("?>" in lowerContent.drop(2)) null else HtmlBlock("?>")
            }
            if (lowerContent.startsWith("<![cdata[")) {
                return if ("]]>" in lowerContent.drop(9)) null else HtmlBlock("]]>")
            }
            if (
                content.startsWith("<!") &&
                (content.getOrNull(2) in 'A'..'Z' || content.getOrNull(2) in 'a'..'z')
            ) {
                return if ('>' in content.drop(2)) null else HtmlBlock(">")
            }

            if (TYPE_SIX.containsMatchIn(line) || TYPE_SEVEN.matches(line)) return HtmlBlock(null)
            return null
        }

        private fun commonMarkContent(line: String): String? {
            var index = 0
            while (index < line.length && line[index] == ' ') {
                index += 1
                if (index > 3) return null
            }
            return line.substring(index)
        }

        private fun fenceMarker(line: String): FenceMarker? {
            var index = 0
            while (index < line.length && index < 4 && line[index] == ' ') index += 1
            if (index > 3 || index >= line.length) return null
            val character = line[index]
            if (character != '`' && character != '~') return null
            val start = index
            while (index < line.length && line[index] == character) index += 1
            val length = index - start
            if (length < 3) return null
            return FenceMarker(character, length, line.substring(index))
        }

        private val TAG = Regex(
            """^<attached-(image|file)[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*/>[\t ]*$""",
        )

        private val COMMONMARK_BLOCK_TAGS = listOf(
            "address", "article", "aside", "base", "basefont", "blockquote", "body", "caption", "center", "col",
            "colgroup", "dd", "details", "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure",
            "footer", "form", "frame", "frameset", "h[1-6]", "head", "header", "hr", "html", "iframe", "legend",
            "li", "link", "main", "menu", "menuitem", "nav", "noframes", "ol", "optgroup", "option", "p",
            "param", "search", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title",
            "tr", "track", "ul",
        ).joinToString("|")
        private val PASTED_TEXT_START = Regex("""^ {0,3}<pasted-text(?:[\t >]|$)""", RegexOption.IGNORE_CASE)
        private val TYPE_ONE = Regex(
            """^ {0,3}<(script|pre|style|textarea)(?:[\t ]|>|$)""",
            RegexOption.IGNORE_CASE,
        )
        private val TYPE_SIX = Regex(
            """^ {0,3}</?(?:$COMMONMARK_BLOCK_TAGS)(?:[\t ]|/?>|$)""",
            RegexOption.IGNORE_CASE,
        )
        private val TYPE_SEVEN = Regex(
            """^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[\t ]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[\t ]*=[\t ]*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*[\t ]*/?>|</[A-Za-z][A-Za-z0-9-]*[\t ]*>)[\t ]*$""",
        )

        private fun decodeAttribute(value: String): String = value
            .replace("&#9;", "\t")
            .replace("&#10;", "\n")
            .replace("&#13;", "\r")
            .replace("&quot;", "\"")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&amp;", "&")

        internal fun displayName(
            providedName: String?,
            path: String,
            kind: DisplayedMessageAttachment.Kind,
        ): String {
            fun basename(source: String?): String? {
                val value = source?.trim()?.split('/', '\\')?.lastOrNull(String::isNotEmpty)
                return value?.takeUnless { it == "." || it == ".." }
            }
            val fallback = basename(path)
            val providedBasename = basename(providedName)
            val generic = when (kind) {
                DisplayedMessageAttachment.Kind.IMAGE -> "Image"
                DisplayedMessageAttachment.Kind.FILE -> "File"
            }
            return sanitisePortableFilename(providedBasename ?: fallback ?: generic, generic)
        }
    }
}

/** Preserve the server path exactly for the originating message's authenticated file route. */
val Message.generatedImages: List<DisplayedMessageAttachment>
    get() = attachments.orEmpty()
        .filter { it.kind == "image" && !it.path.isNullOrBlank() }
        .distinctBy { it.path }
        .map {
            val path = requireNotNull(it.path)
            DisplayedMessageAttachment(
                kind = DisplayedMessageAttachment.Kind.IMAGE,
                path = path,
                name = AttachedMessageContent.displayName(null, path, DisplayedMessageAttachment.Kind.IMAGE),
            )
        }
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data

val Message.displayedContent: AttachedMessageContent
    get() = AttachedMessageContent.parse(text.orEmpty(), markdownImages = role == Message.Role.BOT)
