# linklens
Plugin for Obsidian, to emulate the backlinks filters in Roam Research. Search all list items that contain a specific [[link]], and then filter the research by property value or by adding or removing suggested [[links]] contained in the results.

The plugin search for the following section types:
- `paragraph` - regular text paragraphs
- table - entire markdown tables
- list - list items
  - It finds all the individual list items within that section using cache.listItems and processes each list item separately
- footnoteDefinition - footnote definitions
- callout - callout blocks
