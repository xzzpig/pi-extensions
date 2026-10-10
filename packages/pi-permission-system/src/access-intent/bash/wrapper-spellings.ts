/** Fork: retain upstream word spellings when a wrapper slices out a command. */
import type { ArgumentSpeller } from "./command-enumeration";
import { commandWordNodes } from "./nested-execution";
import type { WordReader } from "./node-text";
import type { TSNode } from "./parser";
import type { CommandWord } from "./wrapper-analysis";

/**
 * Reuse the original nodes' path answers, including their effective directory.
 * Only complete, unambiguous word spans qualify. Opaque/reparsed payloads must
 * keep their own facts rather than borrowing the outer command's shell scope.
 */
export function makeWrapperFragmentSpeller(
	node: TSNode,
	text: string,
	words: readonly CommandWord[],
	reader: WordReader,
	speller: ArgumentSpeller | undefined,
): (fragment: string) => readonly string[] | undefined {
	const nodes = commandWordNodes(node);
	return (fragment) => {
		if (!fragment || nodes.length !== words.length) return undefined;
		const spans = words.flatMap((word, start) => {
			const end = word.offset + fragment.length;
			if (text.slice(word.offset, end) !== fragment) return [];
			const last = words.findIndex((candidate, index) => index >= start &&
				candidate.offset + candidate.text.length === end);
			return last < start ? [] : [{ start, last }];
		});
		if (spans.length !== 1) return undefined;
		const { start, last } = spans[0];
		const offset = words[start].offset;
		let spelled = "";
		let previousEnd = 0;
		for (let index = start; index <= last; index++) {
			const word = words[index];
			const relative = word.offset - offset;
			spelled += fragment.slice(previousEnd, relative);
			spelled += (!word.computed ? speller?.absoluteSpellingOf(nodes[index]) : undefined) ?? word.text;
			previousEnd = relative + word.text.length;
		}
		const spellings = [...new Set([reader.spellHomeAtStart(fragment), spelled])]
			.filter((candidate): candidate is string => candidate !== undefined && candidate !== fragment);
		return spellings.length === 0 ? undefined : spellings;
	};
}
