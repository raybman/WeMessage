#!/usr/bin/env osascript -l JavaScript
// Synthetic typedstream corpus generator (macOS-only; never runs in CI).
//
// Provenance (spec Part 3.2): the corpus must contain synthetic content only.
// This script produces attributedBody-format blobs with Apple's own serializer
// (NSArchiver -> "streamtyped" typedstream, the exact wire format Messages
// stores in chat.db) from GL-FIX-* string literals below. No Messages data is
// read; every byte of string content in the output originates in this file.
// The message_summary_info fixture is a binary plist ({amc, ec: {part ->
// [{d, t}]}}, the shape Messages writes for edited messages) whose embedded
// revisions are typedstream blobs generated the same way.
//
// Usage: osascript -l JavaScript fixtures/harvest/generate-corpus.jxa.js <outDir>
// Review gate: run `strings <outDir>/*.bin` and confirm only GL-FIX content
// before moving blobs into fixtures/typedstream/ (spec Part 3.2 step 3).
ObjC.import('Foundation');
ObjC.import('AppKit'); // surfaces the NS(Mutable)AttributedString initializers to the bridge

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- osascript JXA entry point
function run(argv) {
  const outDir = argv[0];
  if (!outDir) throw new Error('usage: generate-corpus.jxa.js <outDir>');
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
    $(outDir),
    true,
    $(),
    $(),
  );

  function attributed(text, attrs) {
    // The JXA bridge does not surface -initWithString: on this class; build
    // empty and set the backing mutable string instead (same archived result).
    const s = $.NSMutableAttributedString.alloc.init;
    s.mutableString.setString($(text));
    const len = s.length;
    // Messages tags every part; mirror that on the whole range by default.
    s.addAttributeValueRange(
      $('__kIMMessagePartAttributeName'),
      $.NSNumber.numberWithInt(0),
      $.NSMakeRange(0, len),
    );
    for (const a of attrs || []) {
      s.addAttributeValueRange($(a.name), a.value, $.NSMakeRange(a.loc, a.len));
    }
    return s;
  }

  function archive(attributedString) {
    return $.NSArchiver.archivedDataWithRootObject(attributedString);
  }

  function writeData(name, data) {
    data.writeToFileAtomically($(outDir + '/' + name), true);
  }

  // ---- golden cases (Part 3.1) --------------------------------------------
  const plain = 'GL-FIX-001 plain ascii body';
  writeData('plain-ascii.bin', archive(attributed(plain)));

  writeData(
    'emoji.bin',
    archive(attributed('GL-FIX-002 emoji \u{1F44D}\u{1F3FD}\u{1F525}')),
  );

  writeData(
    'multiline.bin',
    archive(attributed('GL-FIX-003\nmultiline second line')),
  );

  const urlText = 'GL-FIX-004 https://example.com';
  writeData(
    'url-with-linkmeta.bin',
    archive(
      attributed(urlText, [
        {
          name: '__kIMLinkAttributeName',
          value: $.NSURL.URLWithString($('https://example.com')),
          loc: urlText.indexOf('https'),
          len: 'https://example.com'.length,
        },
        {
          name: '__kIMLinkIsRichLinkAttributeName',
          value: $.NSNumber.numberWithBool(true),
          loc: urlText.indexOf('https'),
          len: 'https://example.com'.length,
        },
      ]),
    ),
  );

  // Edited message: message_summary_info bplist with two typedstream revisions.
  const rev1 = archive(attributed('GL-FIX-005 original body'));
  const rev2 = archive(attributed('GL-FIX-005 edited body (v2)'));
  const summary = $.NSMutableDictionary.alloc.init;
  summary.setObjectForKey($.NSNumber.numberWithInt(1), $('amc'));
  const revs = $.NSMutableArray.alloc.init;
  const mkRev = (data, when) => {
    const d = $.NSMutableDictionary.alloc.init;
    d.setObjectForKey($.NSNumber.numberWithDouble(when), $('d'));
    d.setObjectForKey(data, $('t'));
    return d;
  };
  revs.addObject(mkRev(rev1, 778000000.0));
  revs.addObject(mkRev(rev2, 778000060.0));
  const ec = $.NSMutableDictionary.alloc.init;
  ec.setObjectForKey(revs, $('0'));
  summary.setObjectForKey(ec, $('ec'));
  const plist =
    $.NSPropertyListSerialization.dataWithPropertyListFormatOptionsError(
      summary,
      $.NSPropertyListBinaryFormat_v1_0,
      0,
      $(),
    );
  writeData('edited-summary-info.bin', plist);

  // Attachment with caption: object-replacement char then caption text.
  writeData(
    'attachment-caption.bin',
    archive(
      attributed('￼ GL-FIX-006 attachment caption', [
        {
          name: '__kIMFileTransferGUIDAttributeName',
          value: $('GL-FIX-SYNTHETIC-TRANSFER-GUID'),
          loc: 0,
          len: 1,
        },
      ]),
    ),
  );

  // @-mention attributed run.
  const mentionText = 'GL-FIX-007 hey @Test Mention are you there';
  writeData(
    'mention.bin',
    archive(
      attributed(mentionText, [
        {
          name: '__kIMMentionConfirmedMention',
          value: $('+15555550100'),
          loc: mentionText.indexOf('@Test'),
          len: '@Test Mention'.length,
        },
      ]),
    ),
  );

  // > 4 KB body: exercises the multi-byte typedstream length prefix.
  const lorem =
    'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor GL-FIX filler ';
  let long = 'GL-FIX-008 long body ';
  while (long.length <= 4096) long += lorem;
  writeData('long-4k.bin', archive(attributed(long)));

  // Malformed cases (Part 3.1: "synthesized in-repo") are derived from
  // plain-ascii.bin by fixtures/harvest/synthesize-malformed.ts (pure Node,
  // deterministic) — run it after this script.
  return 'wrote corpus to ' + outDir;
}
