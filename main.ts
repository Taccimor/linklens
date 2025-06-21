// 1. Imports
import {
	App,
	Editor,
	ItemView,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Plugin,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

export async function findLinkedBlocks(
	targetFile: TFile,
	app: App
): Promise<{ file: TFile; blocks: string[] }[]> {
	const rawResults: { file: TFile; block: string }[] = [];
	const allFiles = app.vault.getMarkdownFiles();

	for (const file of allFiles) {
		const cache = app.metadataCache.getFileCache(file);
		// Skip files without lists
		if (!cache?.listItems) continue;

		const content = await app.vault.cachedRead(file);
		const lines = content.split("\n");

		// Get all list items in the file
		const listItems = cache.listItems;

		for (const listItem of listItems) {
			const listItemContent = lines[listItem.position.start.line];

			// Skip list items without links
			if (!listItemContent.includes("[[")) continue;

			// Extract links from the list item
			const linksInItem = listItemContent.match(/\[\[(.*?)\]\]/g) || [];

			for (const link of linksInItem) {
				// Extract link text (remove brackets)
				const linkText = link.slice(2, -2).split("|")[0];
				const resolved = app.metadataCache.getFirstLinkpathDest(
					linkText,
					file.path
				);

				// Check if this link points to our target file
				if (resolved?.path === targetFile.path) {
					// Extract the entire list item block
					let blockStart = listItem.position.start.line;
					let blockEnd = listItem.position.end.line;

					// Include any continuation lines (multi-line list items)
					while (blockEnd < lines.length - 1) {
						const nextLine = lines[blockEnd + 1];
						// Check if next line is part of same list item
						if (
							nextLine.trim() === "" ||
							nextLine.startsWith("-") ||
							nextLine.startsWith("*") ||
							nextLine.match(/^\s*\d+\./)
						)
							break;
						blockEnd++;
					}

					const block = lines
						.slice(blockStart, blockEnd + 1)
						.join("\n");
					rawResults.push({ file, block });
					break; // Only need one match per list item
				}
			}
		}
	}

	// Group blocks by file
	const grouped = new Map<string, { file: TFile; blocks: string[] }>();
	for (const { file, block } of rawResults) {
		const key = file.path;
		if (!grouped.has(key)) {
			grouped.set(key, { file, blocks: [] });
		}
		grouped.get(key)!.blocks.push(block);
	}

	return Array.from(grouped.values());
}

// Improved paragraph extraction that handles different block types
function extractParagraphAroundLine(
	content: string,
	lineNumber: number
): string {
	const lines = content.split("\n");
	let start = lineNumber;
	let end = lineNumber;

	// Determine the indentation level if in a list
	const currentLine = lines[lineNumber];
	const match = currentLine.match(/^(\s*)/);
	const currentIndent = match ? match[1] : "";

	// Move up to find paragraph start
	while (start > 0) {
		const prevLine = lines[start - 1];

		// Stop at empty lines
		if (prevLine.trim() === "") break;

		// Stop at headings
		if (prevLine.startsWith("#")) break;

		// Stop at different indentation levels in lists
		if (currentIndent) {
			const prevIndent = prevLine.match(/^(\s*)/)?.[1] || "";
			if (prevIndent.length < currentIndent.length) break;
		}

		// Stop at block boundaries
		if (prevLine.trim().endsWith(":") && !prevLine.includes("::")) break;

		start--;
	}

	// Move down to find paragraph end
	while (end < lines.length - 1) {
		const nextLine = lines[end + 1];

		// Stop at empty lines
		if (nextLine.trim() === "") break;

		// Stop at headings
		if (nextLine.startsWith("#")) break;

		// Stop at different indentation levels in lists
		if (currentIndent) {
			const nextIndent = nextLine.match(/^(\s*)/)?.[1] || "";
			if (nextIndent.length < currentIndent.length) break;
		}

		// Stop at block boundaries
		if (nextLine.trim().endsWith(":") && !nextLine.includes("::")) break;

		end++;
	}

	return lines.slice(start, end + 1).join("\n");
}

// 2. View Type constant
const VIEW_TYPE_SEARCH_RESULTS = "search-results-view";

// 3. SearchResultView class
class SearchResultView extends ItemView {
	private results: { 
		file: TFile; 
		blocks: { content: string; startLine: number; endLine: number }[] 
	}[] = [];
	private searchInput: HTMLInputElement;
	private resultsContainer: HTMLElement;
	private dropdown: SuggestionDropdown | null = null;
	private tagsContainer: HTMLElement; // container for search tags
	private currentSearches: string[] = [];
	private suggestedTagsContainer: HTMLElement; // New container for suggested tags
	private propertyButtonsContainer: HTMLElement;
	private updatePropertyButtons() {
		if (!this.propertyButtonsContainer) return;
		this.propertyButtonsContainer.innerHTML = "";

		// Don't show buttons if no search terms
		if (this.currentSearches.length === 0) return;

		const propertiesMap = new Map<string, Set<string>>();

		for (const result of this.results) {
			const cache = this.app.metadataCache.getFileCache(result.file);
			if (cache?.frontmatter) {
				for (const [key, value] of Object.entries(cache.frontmatter)) {
					// Skip null/undefined values
					if (value === null || value === undefined) continue;

					if (!propertiesMap.has(key)) {
						propertiesMap.set(key, new Set());
					}

					if (Array.isArray(value)) {
						value.forEach((v) => {
							// Skip null/undefined array elements
							if (v !== null && v !== undefined) {
								propertiesMap.get(key)!.add(v.toString());
							}
						});
					} else {
						propertiesMap.get(key)!.add(value.toString());
					}
				}
			}
		}

		// Create buttons for each property
		for (const [property, values] of propertiesMap) {
			const button = this.propertyButtonsContainer.createEl("button", {
				cls: "property-button",
			});

			// Button container for text and arrow
			const buttonContent = button.createSpan();
			buttonContent.style.display = "flex";
			buttonContent.style.alignItems = "center";
			buttonContent.style.gap = "2px";

			// Property name
			const propertyText = buttonContent.createSpan({ text: property });
			propertyText.style.fontSize = "0.8em";

			// Dropdown indicator
			const arrow = buttonContent.createSpan({ text: "▼" });
			arrow.style.fontSize = "0.6em";
			arrow.style.opacity = "0.7";

			button.style.padding = "1px 6px"; // Smaller padding
			button.style.fontSize = "0.8em"; // Smaller font
			button.style.borderRadius = "12px";
			button.style.backgroundColor = "var(--background-secondary)";
			button.style.border = "none";
			button.style.cursor = "pointer";
			button.style.display = "flex";
			button.style.alignItems = "center";

			button.addEventListener("click", (e: MouseEvent) => {
				this.showPropertyDropdown(button, property, Array.from(values));
			});
		}
		const refreshButton = this.propertyButtonsContainer.createEl("button", {
			text: "↻",
			cls: "refresh-button",
		});
		refreshButton.addEventListener("click",(e: MouseEvent)=> {
			this.performSearch();
		})
	}
	private showPropertyDropdown(
		button: HTMLElement,
		property: string,
		values: string[]
	) {
		// Remove existing dropdowns
		this.containerEl
			.querySelectorAll(".property-dropdown")
			.forEach((el) => el.remove());

		const dropdown = createDiv({ cls: "property-dropdown" });
		dropdown.style.position = "absolute";
		dropdown.style.backgroundColor = "var(--background-primary)";
		dropdown.style.border = "1px solid var(--background-modifier-border)";
		dropdown.style.borderRadius = "4px";
		dropdown.style.boxShadow = "0 2px 10px rgba(0,0,0,0.1)";
		dropdown.style.zIndex = "1000";
		dropdown.style.maxHeight = "200px";
		dropdown.style.overflowY = "auto";

		// Position below button relative to view container
		const buttonRect = button.getBoundingClientRect();
		const containerRect = this.containerEl.getBoundingClientRect();
		dropdown.style.top = `${buttonRect.bottom - containerRect.top + 5}px`;
		dropdown.style.left = `${buttonRect.left - containerRect.left}px`;

		this.containerEl.appendChild(dropdown);

		// Add values to dropdown
		values.forEach((value) => {
			const item = dropdown.createDiv({
				text: value,
				cls: "property-dropdown-item",
			});
			item.style.padding = "6px 12px";
			item.style.cursor = "pointer";

			item.addEventListener("click", () => {
				// Add property:value filter
				this.addSearchTerm(`${property}:${value}`);
				dropdown.remove();
			});

			// Add hover effect
			item.addEventListener("mouseover", () => {
				item.style.backgroundColor = "var(--background-secondary)";
			});
			item.addEventListener("mouseout", () => {
				item.style.backgroundColor = "";
			});
		});

		// Close on outside click
		const clickHandler = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!dropdown.contains(target)) {
				dropdown.remove();
				document.removeEventListener("click", clickHandler);
			}
		};

		// Use setTimeout to avoid immediate close
		setTimeout(() => {
			document.addEventListener("click", clickHandler);
		}, 0);
	}

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType() {
		return VIEW_TYPE_SEARCH_RESULTS;
	}

	getDisplayText() {
		return "Link Search";
	}

	getIcon(): string {
		return "search";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = "10px";

		// Create search container
		const searchContainer = container.createDiv();
		searchContainer.style.marginBottom = "20px";
		searchContainer.style.position = "relative"; // Needed for dropdown
		searchContainer.style.padding = "15px"; // Add padding
		searchContainer.style.backgroundColor = "var(--background-secondary)"; // Background color
		searchContainer.style.borderRadius = "8px"; // Rounded corners
		searchContainer.style.border =
			"1px solid var(--background-modifier-border)"; // Border

		// Create search form
		const form = searchContainer.createEl("form");
		form.style.display = "flex";
		form.style.gap = "10px";
		form.style.marginBottom = "10px";

		// Create search input
		this.searchInput = form.createEl("input", {
			type: "text",
			placeholder: "Type a link name and press Enter...",
		});
		this.searchInput.style.flexGrow = "1";
		this.searchInput.addClass("search-input");

		// Create dropdown container
		const dropdownContainer = searchContainer.createDiv();

		// Create property buttons container
		this.propertyButtonsContainer = container.createDiv();
		this.propertyButtonsContainer.style.display = "flex";
		this.propertyButtonsContainer.style.flexWrap = "wrap";
		this.propertyButtonsContainer.style.gap = "5px";
		this.propertyButtonsContainer.style.marginBottom = "10px";

		// Create active tags row container
		const activeTagsRow = container.createDiv();
		// tagsRow.style.display = "flex";
		// tagsRow.style.justifyContent = "space-between";
		activeTagsRow.style.marginBottom = "10px";

		this.tagsContainer = activeTagsRow.createDiv();
		this.tagsContainer.style.maxHeight = "12.5rem";
		this.tagsContainer.style.overflowY = "auto";
		// this.tagsContainer.style.display = "flex";
		// this.tagsContainer.style.flexWrap = "wrap";
		// this.tagsContainer.style.gap = "5px";
		// this.tagsContainer.style.flex = "1";

		// Create suggested tags row container
		const suggestedTagsRow = container.createDiv();
		// tagsRow.style.display = "flex";
		// tagsRow.style.justifyContent = "space-between";
		suggestedTagsRow.style.marginBottom = "10px";

		this.suggestedTagsContainer = suggestedTagsRow.createDiv();
		this.suggestedTagsContainer.style.maxHeight = "12.5rem";
		this.suggestedTagsContainer.style.overflowY = "auto";
		// this.suggestedTagsContainer.style.display = "flex";
		// this.suggestedTagsContainer.style.justifyContent = "flex-end";
		// this.suggestedTagsContainer.style.flexWrap = "wrap";
		// this.suggestedTagsContainer.style.gap = "5px";
		// this.suggestedTagsContainer.style.flex = "1";

		this.suggestedTagsContainer.createEl("span", {
			text: "Suggestions: ",
			cls: "suggested-label",
		});

		// Initialize dropdown with multi-term callback
		this.dropdown = new SuggestionDropdown(
			this.app,
			this.searchInput,
			dropdownContainer,
			(value) => {
				this.addSearchTerm(value);
			}
		);

		// Create results container with top border for separation
		this.resultsContainer = container.createDiv();
		this.resultsContainer.style.overflowY = "auto";
		// this.resultsContainer.style.height = "calc(100% - 150px)"; // Adjust height
		this.resultsContainer.style.height = "auto"; // Adjust height
		this.resultsContainer.style.borderTop =
			"1px solid var(--background-modifier-border)"; // Separation line
		this.resultsContainer.style.paddingTop = "15px"; // Add top padding
		this.resultsContainer.style.marginTop = "10px"; // Add top margin

		// Handle form submission
		form.addEventListener("submit", (e) => {
			e.preventDefault();
			this.addSearchTerm(this.searchInput.value);
		});

		this.searchInput.focus();
	}

	// Add a search term to the current searches
	addSearchTerm(term: string) {
		term = term.trim();
		if (!term) return;

		// Add to current searches if not already present
		if (!this.currentSearches.includes(term)) {
			this.currentSearches.push(term);
			this.renderSearchTags();
			this.performSearch();
		}

		// Clear input
		this.searchInput.value = "";
		this.searchInput.focus();
	}

	// Render all search tags
	renderSearchTags() {
		this.tagsContainer.empty();

		for (const term of this.currentSearches) {
			const buttonText =
				term.length > 45 ? term.slice(0, 45) + " \u2026" : term;
			const tag = this.tagsContainer.createEl("button", {
				title: term,
				text: buttonText,
				cls: "search-tag",
			});

			tag.style.padding = "2px 8px";
			tag.style.borderRadius = "12px";
			tag.style.backgroundColor = "var(--background-secondary)";
			tag.style.border = "none";
			tag.style.cursor = "pointer";
			tag.style.margin = "4px";
			// tag.style.display = "flex";
			// tag.style.alignItems = "center";
			tag.style.gap = "4px";

			// Add close icon
			const closeIcon = tag.createSpan({
				text: "✕",
				cls: "tag-close",
			});
			closeIcon.style.fontSize = "0.8em";

			// Handle tag click (remove this term)
			tag.addEventListener("click", (e) => {
				e.stopPropagation();
				this.removeSearchTerm(term);
			});
		}
	}

	// Perform search with all current terms
	async performSearch() {
		if (this.currentSearches.length === 0) {
			this.showMessage("No search terms");
			this.results = [];
			this.updatePropertyButtons(); // Clears property buttons
			this.updateSuggestedTags(); // Clears suggested tags
			return;
		}

		this.showMessage("Searching...");

		try {
			// Directly use the search terms without resolving to files
			const blocks = await this.findLinkedBlocksForMultiple(
				this.currentSearches
			);
			this.setResults(blocks);
		} catch (e) {
			this.showMessage("Error during search: " + e.message);
		}
	}

	// Find blocks containing links to ALL target terms
	async findLinkedBlocksForMultiple(
		targetTerms: string[]
	): Promise<{ 
		file: TFile; 
		blocks: { content: string; startLine: number; endLine: number }[] 
	}[]> {
		// Separate property filters and link terms
		const propertyFilters: Record<string, string> = {};
		const linkTerms: string[] = [];

		targetTerms.forEach((term) => {
			if (term.includes(":")) {
				const [key, value] = term.split(":").map((s) => s.trim());
				propertyFilters[key] = value;
			} else {
				linkTerms.push(term);
			}
		});

		if (
			linkTerms.length === 0 &&
			Object.keys(propertyFilters).length === 0
		) {
			return [];
		}

		const rawResults: { 
			file: TFile; 
			block: string; 
			startLine: number; 
			endLine: number 
		}[] = [];
		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			// Apply property filters first
			if (Object.keys(propertyFilters).length > 0) {
				const cache = this.app.metadataCache.getFileCache(file);
				const frontmatter = cache?.frontmatter || {};
				let matches = true;

				for (const [key, value] of Object.entries(propertyFilters)) {
					const propValue = frontmatter[key];

					// Handle null/undefined values
					if (propValue === null || propValue === undefined) {
						matches = false;
						break;
					}

					// Check if property value doesn't match
					let valueMatches = false;
					if (Array.isArray(propValue)) {
						valueMatches = propValue.includes(value);
					} else {
						valueMatches = propValue.toString() === value;
					}

					if (!valueMatches) {
						matches = false;
						break;
					}
				}

				// Skip file if it doesn't match property filters
				if (!matches) {
					continue;
				}
			}

			// Process sections/blocks for the file
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.sections) continue;

			const content = await this.app.vault.cachedRead(file);
			const lines = content.split("\n");

			for (const section of cache.sections) {
				// Skip if section doesn't have a position
				if (!section.position) continue;
				
				// Only process specific section types
				if (section.type !== "paragraph" && 
					section.type !== "table" && 
					section.type !== "list" && 
					section.type !== "footnoteDefinition" && 
					section.type !== "callout") continue;

				const sectionStart = section.position.start.line;
				const sectionEnd = section.position.end.line;
				
				// Handle list sections specially - break them into individual items
				if (section.type === "list") {
					const listItems = cache.listItems || [];
					const sectionListItems = listItems.filter(item => 
						item.position.start.line >= sectionStart && 
						item.position.end.line <= sectionEnd
					);
					
					for (const listItem of sectionListItems) {
						const itemStart = listItem.position.start.line;
						const itemEnd = listItem.position.end.line;
						const block = lines.slice(itemStart, itemEnd + 1).join("\n");
						
						// Skip if block doesn't contain any wikilinks
						if (!block.includes("[[")) continue;

						// Extract links from the block
						const linksInBlock = block.match(/\[\[(.*?)\]\]/g) || [];
						const linkTargets = linksInBlock.map((link) => {
							return link.slice(2, -2).split("|")[0].trim();
						});

						// Check for link terms
						if (linkTerms.length > 0) {
							const containsAllTargets = linkTerms.every((targetTerm) => {
								return linkTargets.some((linkTarget) => {
									return (
										linkTarget.toLowerCase() ===
										targetTerm.toLowerCase()
									);
								});
							});

							if (!containsAllTargets) {
								continue;
							}
						}

						// Add to results
						rawResults.push({ 
							file, 
							block,
							startLine: itemStart,
							endLine: itemEnd
						});
					}
				} else {
					// Handle other section types normally
					const block = lines.slice(sectionStart, sectionEnd + 1).join("\n");
					
					// Skip if block doesn't contain any wikilinks
					if (!block.includes("[[")) continue;

					// Extract links from the block
					const linksInBlock = block.match(/\[\[(.*?)\]\]/g) || [];
					const linkTargets = linksInBlock.map((link) => {
						return link.slice(2, -2).split("|")[0].trim();
					});

					// Check for link terms
					if (linkTerms.length > 0) {
						const containsAllTargets = linkTerms.every((targetTerm) => {
							return linkTargets.some((linkTarget) => {
								return (
									linkTarget.toLowerCase() ===
									targetTerm.toLowerCase()
								);
							});
						});

						if (!containsAllTargets) {
							continue;
						}
					}

					// Add to results
					rawResults.push({ 
						file, 
						block,
						startLine: sectionStart,
						endLine: sectionEnd
					});
				}
			}
		}

		// Group blocks by file
		const grouped = new Map<string, { 
			file: TFile; 
			blocks: { content: string; startLine: number; endLine: number }[] 
		}>();
		
		for (const { file, block, startLine, endLine } of rawResults) {
			const key = file.path;
			if (!grouped.has(key)) {
				grouped.set(key, { 
					file, 
					blocks: [] 
				});
			}
			grouped.get(key)!.blocks.push({
				content: block,
				startLine,
				endLine
			});
		}

		return Array.from(grouped.values());
	}

	// Remove a specific search term
	removeSearchTerm(term: string) {
		this.currentSearches = this.currentSearches.filter((t) => t !== term);
		this.renderSearchTags();
		this.performSearch();

		// Add this check to clear suggestions when no terms remain
		if (this.currentSearches.length === 0) {
			this.updateSuggestedTags();
		}
	}

	// Add a search tag below the search bar
	addSearchTag(term: string) {
		// Clear existing tags
		this.tagsContainer.empty();

		const buttonText =
			term.length > 45 ? term.slice(0, 45) + " \u2026" : term;
		const tag = this.tagsContainer.createEl("button", {
			title: term,
			text: buttonText,
			cls: "search-tag",
		});

		tag.style.padding = "2px 8px";
		tag.style.borderRadius = "12px";
		tag.style.backgroundColor = "var(--background-secondary)";
		tag.style.border = "none";
		tag.style.cursor = "pointer";
		tag.style.display = "flex";
		tag.style.alignItems = "center";
		tag.style.gap = "4px";

		// Add close icon
		const closeIcon = tag.createSpan({
			text: "✕",
			cls: "tag-close",
		});
		closeIcon.style.fontSize = "0.8em";

		// Handle tag click
		tag.addEventListener("click", () => {
			// Clear search
			this.searchInput.value = "";
			this.tagsContainer.empty();
			this.resultsContainer.empty();
			this.results = [];
			this.searchInput.focus();
		});
	}

	setResults(results: { 
		file: TFile; 
		blocks: { content: string; startLine: number; endLine: number }[] 
	}[]) {
		this.results = results;
		this.renderResults();
		this.updatePropertyButtons();
		this.updateSuggestedTags();
	}

	// Update suggested tags from search results
	private updateSuggestedTags() {
		if (!this.suggestedTagsContainer) return;
		this.suggestedTagsContainer.innerHTML = "";
		// Don't show tags if no search terms
		if (this.currentSearches.length === 0) return;

		const suggestionLabel = this.suggestedTagsContainer.createEl("span", {
			text: "Related links: ",
			cls: "suggested-label",
		});
		suggestionLabel.style.marginRight = "5px";

		// Collect all unique links from results
		const allLinks = new Set<string>();

		for (const result of this.results) {
			for (const block of result.blocks) {
				// Extract all links from the block
				const linksInBlock = block.content.match(/\[\[(.*?)\]\]/g) || [];
				for (const link of linksInBlock) {
					const linkText = link.slice(2, -2).split("|")[0].trim();
					// Only include links not in current searches
					if (linkText && !this.currentSearches.includes(linkText)) {
						allLinks.add(linkText);
					}
				}
			}
		}

		// Create buttons for each suggested link
		allLinks.forEach((link) => {
			const buttonText =
				link.length > 45 ? link.slice(0, 45) + " \u2026" : link;

			const tag = this.suggestedTagsContainer.createEl("button", {
				title: link,
				text: buttonText,
				cls: "suggested-tag",
			});

			tag.style.padding = "2px 8px";
			tag.style.borderRadius = "12px";
			tag.style.backgroundColor = "var(--background-primary-alt)";
			tag.style.border = "none";
			tag.style.cursor = "pointer";
			tag.style.marginLeft = "3px";

			tag.addEventListener("click", () => {
				this.addSearchTerm(link);
			});
		});
	}

	showMessage(message: string) {
		this.resultsContainer.empty();
		this.resultsContainer.createEl("p", { text: message });
	}

	renderResults() {
		this.resultsContainer.empty();

		if (this.results.length === 0) {
			this.resultsContainer.createEl("p", { text: "No matches found." });
			return;
		}

		for (const result of this.results) {
			const fileHeader = this.resultsContainer.createEl("div", {
				cls: "search-result-file",
			});
			const headerContent = fileHeader.createDiv({
				cls: "file-header-content",
			});

			// File name with clickable link
			const fileName = headerContent.createEl("h4", {
				text: result.file.basename,
			});
			fileName.style.cursor = "pointer";
			fileName.style.display = "inline-block";
			fileName.style.marginRight = "10px";
			fileName.addEventListener("click", () => {
				this.app.workspace.openLinkText(result.file.path, "");
			});

			for (const block of result.blocks) {
				const blockContainer = this.resultsContainer.createDiv();
				blockContainer.style.position = "relative";
				blockContainer.style.marginBottom = "1.5em";
				blockContainer.style.backgroundColor =
					"var(--background-secondary)";
				blockContainer.style.padding = "1em";
				blockContainer.style.borderRadius = "8px";
				blockContainer.style.border =
					"1px solid var(--background-modifier-border)";
				blockContainer.style.boxShadow = "0 2px 4px rgba(0,0,0,0.05)";

				// Create markdown content container
				const contentContainer = blockContainer.createDiv();
				contentContainer.style.position = "relative";
				contentContainer.style.padding = "1em";
				contentContainer.style.borderRadius = "6px";
				contentContainer.style.backgroundColor =
					"var(--background-primary)";

				// Render markdown instead of showing raw text
				const blockContent = contentContainer.createDiv();
				MarkdownRenderer.render(
					this.app,
					block.content,
					blockContent,
					result.file.path,
					this
				);

				// Create link icon container
				const linkContainer = blockContainer.createDiv({
					cls: "block-link-container",
				});
				linkContainer.style.position = "absolute";
				linkContainer.style.top = "10px";
				linkContainer.style.right = "10px";
				linkContainer.style.display = "flex";
				linkContainer.style.gap = "8px";

				// Create copy button
				const copyIcon = linkContainer.createEl("a", {
					href: "#",
					cls: "block-action",
					title: "Copy block content",
				});
				copyIcon.innerHTML = "📋";
				copyIcon.addEventListener("click", (e) => {
					e.preventDefault();
					navigator.clipboard.writeText(block.content);
					new Notice("Block content copied to clipboard");
				});

				// Create link icon
				const linkIcon = linkContainer.createEl("a", {
					href: "#",
					cls: "block-action",
					title: "Open link",
				});
				linkIcon.innerHTML = "🔗";
				linkIcon.addEventListener("click", (e) => {
					e.preventDefault();
					this.openBlockReference(result.file, block);
				});

				// Add hover effects
				[copyIcon, linkIcon].forEach((icon) => {
					icon.style.transition = "all 0.2s ease";
					icon.style.textDecoration = "none";
					icon.style.fontSize = "1.1em";
					icon.style.cursor = "pointer";
					icon.style.opacity = "0.7";

					icon.addEventListener("mouseover", () => {
						icon.style.opacity = "1";
						icon.style.transform = "scale(1.2)";
					});

					icon.addEventListener("mouseout", () => {
						icon.style.opacity = "0.7";
						icon.style.transform = "scale(1)";
					});
				});
			}
		}
	}

	// Open block reference in source file
	async openBlockReference(
		file: TFile, 
		block: { content: string; startLine: number; endLine: number }
	) {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);

		if (leaf.view instanceof MarkdownView) {
			const editor = leaf.view.editor;
			
			// Set cursor to start of block
			editor.setCursor({ line: block.startLine, ch: 0 });
			
			// Scroll to block
			editor.scrollIntoView({
				from: { line: Math.max(0, block.startLine - 3), ch: 0 },
				to: { line: block.endLine + 3, ch: 0 },
			}, true);

			// Highlight entire block
			this.highlightBlock(editor, block.startLine, block.endLine);
		}
	}

	// Highlight the block temporarily
	highlightBlock(editor: Editor, startLine: number, endLine: number) {
		const cm = (editor as any).cm;
		if (!cm) return;

		// Clear existing highlights
		cm.getAllMarks().forEach((mark: any) => mark.clear());

		// Add highlight for entire block
		const startPos = { line: startLine, ch: 0 };
		const endPos = { 
			line: endLine, 
			ch: editor.getLine(endLine).length  // Full line length
		};
		
		const highlight = cm.markText(startPos, endPos, {
			className: "block-highlight",
		});

		setTimeout(() => highlight.clear(), 3000);
	}
}

// Custom suggestion dropdown implementation
class SuggestionDropdown {
	private app: App;
	private inputEl: HTMLInputElement;
	private containerEl: HTMLElement;
	private suggestionsEl: HTMLElement;
	private items: string[] = [];
	private selectedIndex: number = -1;
	// Store bound event handlers
	private inputHandler: (e: Event) => void;
	private keydownHandler: (e: KeyboardEvent) => void;
	private onSelectCallback: (value: string) => void; // Callback for selection
	private getAllLinkTargets(): string[] {
		const files = this.app.vault.getMarkdownFiles();
		const existing = files.map((f) => f.basename);

		// Also include non-existent links from the vault
		const nonExistent = new Set<string>();
		const allFiles = this.app.vault.getMarkdownFiles();

		for (const file of allFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache?.links) continue;

			for (const link of cache.links) {
				const linkText = link.link.split("|")[0].trim();
				if (!existing.includes(linkText)) {
					nonExistent.add(linkText);
				}
			}
		}

		return [...existing, ...nonExistent];
	}

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		containerEl: HTMLElement,
		onSelectCallback: (value: string) => void // New callback parameter
	) {
		this.app = app;
		this.inputEl = inputEl;
		this.containerEl = containerEl;
		this.onSelectCallback = onSelectCallback; // Store callback

		// Create suggestions container
		this.suggestionsEl = this.containerEl.createDiv("suggestion-container");
		this.suggestionsEl.style.position = "absolute";
		this.suggestionsEl.style.zIndex = "1000";
		this.suggestionsEl.style.backgroundColor = "var(--background-primary)";
		this.suggestionsEl.style.border =
			"1px solid var(--background-modifier-border)";
		this.suggestionsEl.style.borderRadius = "4px";
		this.suggestionsEl.style.boxShadow = "0 2px 10px rgba(0,0,0,0.1)";
		this.suggestionsEl.style.maxHeight = "200px";
		this.suggestionsEl.style.overflowY = "auto";
		this.suggestionsEl.style.display = "none";

		// Bind event handlers
		this.inputHandler = this.onInput.bind(this);
		this.keydownHandler = this.onKeyDown.bind(this);

		// Add event listeners
		this.inputEl.addEventListener("input", this.inputHandler);
		this.inputEl.addEventListener("keydown", this.keydownHandler);
	}

	// Add a public destroy method
	destroy() {
		this.inputEl.removeEventListener("input", this.inputHandler);
		this.inputEl.removeEventListener("keydown", this.keydownHandler);
	}

	private onInput() {
		const value = this.inputEl.value.toLowerCase();
		this.items = this.getAllLinkTargets().filter((t) =>
			t.toLowerCase().includes(value)
		);

		this.renderSuggestions();
	}

	private renderSuggestions() {
		this.suggestionsEl.empty();

		if (this.items.length === 0) {
			this.suggestionsEl.style.display = "none";
			return;
		}

		this.suggestionsEl.style.display = "block";

		// Get position relative to container
		const containerRect = this.containerEl.getBoundingClientRect();
		const inputRect = this.inputEl.getBoundingClientRect();

		// Calculate position relative to container
		const top = inputRect.bottom - containerRect.top + 50; // Add 5px offset
		const left = inputRect.left - containerRect.left;

		this.suggestionsEl.style.top = `${top}px`;
		this.suggestionsEl.style.left = `${left}px`;
		this.suggestionsEl.style.width = `${inputRect.width}px`;

		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i];
			const div = this.suggestionsEl.createDiv({
				text: item,
				cls: "suggestion-item",
			});

			div.style.padding = "6px 12px";
			div.style.cursor = "pointer";

			if (i === this.selectedIndex) {
				div.style.backgroundColor = "var(--background-secondary)";
			}

			div.addEventListener("click", () => {
				this.inputEl.value = item;
				this.suggestionsEl.style.display = "none";
				this.inputEl.focus();
			});

			div.addEventListener("mouseover", () => {
				this.selectedIndex = i;
				this.highlightSelected();
			});
		}
	}

	private highlightSelected() {
		const items = this.suggestionsEl.querySelectorAll(".suggestion-item");
		items.forEach((el, i) => {
			if (i === this.selectedIndex) {
				(el as HTMLElement).style.backgroundColor =
					"var(--background-secondary)";
			} else {
				(el as HTMLElement).style.backgroundColor = "";
			}
		});
	}

	private onKeyDown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			this.selectedIndex = Math.min(
				this.selectedIndex + 1,
				this.items.length - 1
			);
			this.highlightSelected();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
			this.highlightSelected();
		} else if (e.key === "Enter" && this.selectedIndex >= 0) {
			e.preventDefault();
			const value = this.items[this.selectedIndex];
			this.inputEl.value = value;
			this.suggestionsEl.style.display = "none";
			this.onSelectCallback(value);
		} else if (e.key === "Enter") {
			e.preventDefault();
			this.onSelectCallback(this.inputEl.value);
		} else if (e.key === "Escape") {
			this.suggestionsEl.style.display = "none";
		}
	}
}

export default class SearchPlugin extends Plugin {
	async onload() {
		this.registerView(
			VIEW_TYPE_SEARCH_RESULTS,
			(leaf) => new SearchResultView(leaf)
		);

		this.addCommand({
			id: "open-search-view",
			name: "Open Search Panel",
			callback: () => {
				this.activateView();
			},
		});
	}

	async activateView() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_SEARCH_RESULTS);

		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;

		await leaf.setViewState({
			type: VIEW_TYPE_SEARCH_RESULTS,
			active: true,
		});

		this.app.workspace.revealLeaf(leaf);
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_SEARCH_RESULTS);
	}
}
