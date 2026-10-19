/** Quest-list labels sometimes include "The" while their journals omit it. */
export function questTitleKey(title:string):string {
  return title.trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g,' ');
}
