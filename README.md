# Link Lens
Plugin for Obsidian inspired by the backlinks filters in Roam Research. You can search for all the blocks that contain a specific `[[link]]`, and then you can filter the research by property value or by adding or removing suggested `[[links]]` contained in the results.
## How it works

Launch the plugin by opening the command palette via `CTRL+P` and select `Link Lens: Open Search Panel` (or assign a hotkey to it). By typing in the search bar, all existing and non-existing[^1] links in your vault will be suggested according to what you write (it works with aliases, too). Select one and press Enter. The plugin shows all the blocks that contain that link. Additionally, it shows two things:
- Related links: all the other links that are contained in the blocks found
  - If you left-click on one of the Related links, it will be added to the search terms (with `AND` operator). So the new results will be the blocks that contains only the selected links. On the contrary, if you left-click on one search term, it will be removed from the search terms.
- All the properties that are contained in the notes to which the blocks found belong
  - If you click on one property, it opens up a dropdown list that contains all the values that that property assumes in the notes found. If you click on one value, the search will be filtered and it will preview only the blocks that pertains to the notes with a property that has that specific value. For example, you can search for all the blocks that contains the link `[[link]]` and that at the same time belong to a note in which the property `author` is "me".

[^1]: By "non-existing link" I mean a link that sends to a note that has not been created yet.

### Block parsing logic
In order to define a block, the plugin searches for the following section types (`SectionCache.type`):
- `paragraph` - regular text paragraphs
- `table` - entire markdown tables
- `list` - list items. It finds all the individual list items within that section using `cache.listItems` and processes each list item separately
- `footnoteDefinition` - footnote definitions
- `callout` - callout blocks

The actual search is made by the function `findLinkedBlocksForMultiple()`.

# Vibe coding warning and proposed improvemments
This code has been created mainly with AI because I'm not able to code. It has been reviewed by [Difonzo](https://github.com/Difonzo) who also introduced some features and improved UI, but it's not easy to navigate inside an AI-made code.

<ins>**This code needs some serious refactoring**</ins> and other functions can be introduced:
- Custom sorting of results preview (by Name, date of creation created, date of last edit, ecc.)
- Add the possibility that, if searching for a term that doesn't exist as link, this search is performed as a simple regex search, looking for items that contains an exact match to that term.[^2]
- Add the possibility to customize the research by adding the search terms with `AND`, `OR` or `NOT` operators, and the UI should be re-made accordingly (the container of the search terms `tagsContainer` should be divided in three sections, one for each operator). It can work like this:
  - if you click a Related link it is added with `AND` operator
  - if you Shift-click a Related link it is added with `OR` operator
  - if you Alt-click a Related link it  is added with `NOT` operator


[^2]: Right now the plugin has a bug where if you search a term that doesn't exist as link, the written term changes to "undefined", no search is performed and the console gives this error: `plugin:linklens:8 Uncaught TypeError: Cannot read properties of undefined (reading 'trim')
    at T.addSearchTerm (plugin:linklens:8:4575)
    at L.eval [as onSelectCallback] (plugin:linklens:8:4116)
    at L.onKeyDown (plugin:linklens:12:3425)`
