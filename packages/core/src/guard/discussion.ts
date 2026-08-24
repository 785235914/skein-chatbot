const educationalContext =
  /\b(?:education(?:al)?|discussion|example|explain(?:ing)?|quoted|training|analysis|article)\b/iu;

const closingQuote: Readonly<Record<string, string>> = {
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
};

interface QuotedText {
  readonly segments: readonly string[];
  readonly unquotedText: string;
}

const wordCharacter = /[\p{L}\p{N}]/u;

const isIntraWordApostrophe = (text: string, index: number): boolean =>
  text[index] === "'" &&
  wordCharacter.test(text[index - 1] ?? "") &&
  wordCharacter.test(text[index + 1] ?? "");

const findClosingQuote = (
  text: string,
  closer: string,
  start: number,
): number => {
  let closingIndex = text.indexOf(closer, start);
  while (
    closingIndex >= 0 &&
    closer === "'" &&
    isIntraWordApostrophe(text, closingIndex)
  ) {
    closingIndex = text.indexOf(closer, closingIndex + 1);
  }
  return closingIndex;
};

const splitMatchingQuotedText = (text: string): QuotedText => {
  const segments: string[] = [];
  let unquotedText = "";
  let cursor = 0;

  while (cursor < text.length) {
    const opener = text[cursor]!;
    const closer = closingQuote[opener];
    if (
      closer === undefined ||
      (opener === "'" && isIntraWordApostrophe(text, cursor))
    ) {
      unquotedText += opener;
      cursor += 1;
      continue;
    }

    const closingIndex = findClosingQuote(text, closer, cursor + 1);
    if (closingIndex < 0) {
      unquotedText += opener;
      cursor += 1;
      continue;
    }

    segments.push(text.slice(cursor + 1, closingIndex));
    unquotedText += " ";
    cursor = closingIndex + 1;
  }

  return { segments, unquotedText };
};

export const isClearlyQuotedDiscussion = (
  text: string,
  containsAttack: (candidate: string) => boolean,
): boolean => {
  if (!educationalContext.test(text)) {
    return false;
  }

  const { segments, unquotedText } = splitMatchingQuotedText(text);
  return (
    segments.some((segment) => containsAttack(segment)) &&
    !containsAttack(unquotedText)
  );
};
