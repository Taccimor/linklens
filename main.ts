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
import "./styles.css";

// Constants for magic values
const MAX_TAG_LENGTH = 40;
const HIGHLIGHT_DURATION = 3000;
const OR_WARNING_DURATION = 3000;
const VIEW_TYPE_SEARCH_RESULTS = "search-results-view";
const SORT_OPTIONS = [
    { value: "title", label: "Note title" },
    { value: "modified", label: "Last Edited" },
    { value: "created", label: "Created" }
];

type SearchOperator = "AND" | "OR" | "NOT";
type SearchTerm = {
    term: string;
    isTextSearch: boolean;
    operator: SearchOperator;
};

type BlockResult = {
    content: string;
    startLine: number;
    endLine: number;
    file: TFile;
};

type SearchResultBlock = {
    content: string;
    startLine: number;
    endLine: number;
};

type SearchResult = {
    file: TFile;
    blocks: SearchResultBlock[];
};

type PropertyFilterMap = {
    AND: Record<string, Set<string>>;
    OR: Record<string, Set<string>>;
    NOT: Record<string, Set<string>>;
};

/**
 * Extracts wikilinks from text content
 */
function extractWikilinks(text: string): string[] {
    const matches = text.match(/\[\[(.*?)\]\]/g) || [];
    return matches.map(link => link.slice(2, -2).split("|")[0].trim());
}

/**
 * Utility class for property-related operations
 */
class PropertyUtils {
    /**
     * Extracts properties from search results
     */
    static extractProperties(results: SearchResult[], app: App): Map<string, Set<string>> {
        const propertiesMap = new Map<string, Set<string>>();
        
        for (const result of results) {
            const cache = app.metadataCache.getFileCache(result.file);
            if (!cache?.frontmatter) continue;

            for (const [key, value] of Object.entries(cache.frontmatter)) {
                if (value === null || value === undefined) continue;
                
                if (!propertiesMap.has(key)) {
                    propertiesMap.set(key, new Set());
                }
                
                const valueSet = propertiesMap.get(key)!;
                if (Array.isArray(value)) {
                    value.forEach(v => v && valueSet.add(v.toString()));
                } else {
                    valueSet.add(value.toString());
                }
            }
        }
        return propertiesMap;
    }
}

/**
 * Creates a DOM element with specified attributes
 */
function createDOMElement<K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    options: { 
        text?: string, 
        cls?: string | string[], 
        attributes?: Record<string, string> 
    } = {}
): HTMLElementTagNameMap[K] {
    const el = parent.createEl(tag, {
        text: options.text,
        cls: options.cls,
        attr: options.attributes
    });
    return el;
}

/**
 * Dropdown for search suggestions
 */
class SuggestionDropdown {
    private app: App;
    private inputEl: HTMLInputElement;
    private containerEl: HTMLElement;
    public suggestionsEl: HTMLElement;
    public suggestions: string[] = [];
    private selectedIndex: number = -1;
    private onSelect: (value: string, isTextSearch: boolean, operator: SearchOperator) => void;
    private isVisible = false;
    private isDropdownListenerActive = false;
    private closeDropdownListener: (ev: MouseEvent) => void;

    constructor(
        app: App,
        inputEl: HTMLInputElement,
        containerEl: HTMLElement,
        onSelect: (value: string, isTextSearch: boolean, operator: SearchOperator) => void
    ) {
        this.app = app;
        this.inputEl = inputEl;
        this.containerEl = containerEl;
        this.onSelect = onSelect;

        this.suggestionsEl = createDOMElement(this.containerEl, "div", { 
            cls: "linklens-suggestion-container hidden" 
        });
        this.inputEl.addEventListener("input", this.onInput);
        this.inputEl.addEventListener("keydown", this.onKeyDown);
        this.closeDropdownListener = (ev: MouseEvent) => {
            if (!this.containerEl.contains(ev.target as Node)) {
                this.close();
                document.removeEventListener("mousedown", this.closeDropdownListener);
                this.isDropdownListenerActive = false;
            }
        };
    }

    destroy() {
        this.inputEl.removeEventListener("input", this.onInput);
        this.inputEl.removeEventListener("keydown", this.onKeyDown);
        this.suggestionsEl.remove();
        document.removeEventListener("mousedown", this.closeDropdownListener);
    }

    private onInput = () => {
        const value = this.inputEl.value.toLowerCase();
        this.suggestions = this.getAllLinkTargets().filter(t => t.toLowerCase().includes(value));
        this.selectedIndex = -1;
        this.renderSuggestions();
        
        if (!this.isDropdownListenerActive) {
            this.isDropdownListenerActive = true;
            document.addEventListener("mousedown", this.closeDropdownListener);
        }
        this.suggestionsEl.classList.remove("hidden"); // to show dropdown when typing
    };

    private getAllLinkTargets(): string[] {
        const files = this.app.vault.getMarkdownFiles();
        const existing = files.map(f => f.basename);
        const nonExistent = new Set<string>();
        
        for (const file of files) {
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

    private renderSuggestions() {
        this.suggestionsEl.empty();
        if (this.suggestions.length === 0) {
            this.isVisible = false;
            this.suggestionsEl.classList.add("hidden");
            return;
        }

        this.isVisible = true;
        this.suggestionsEl.classList.remove("hidden");
        this.updateDropdownPosition();
        
        for (let i = 0; i < this.suggestions.length; i++) {
            this.renderSuggestionItem(i);
        }
    }

    private updateDropdownPosition() {
        const containerRect = this.containerEl.getBoundingClientRect();
        const inputRect = this.inputEl.getBoundingClientRect();
        this.suggestionsEl.style.setProperty("--suggestion-top", `${inputRect.bottom - containerRect.top}px`);
        this.suggestionsEl.style.setProperty("--suggestion-left", `${inputRect.left - containerRect.left}px`);
        this.suggestionsEl.style.setProperty("--suggestion-width", `${inputRect.width}px`);
    }

    private renderSuggestionItem(index: number) {
        const item = this.suggestions[index];
        const div = createDOMElement(this.suggestionsEl, "div", {
            text: item,
            cls: "suggestion-item"
        });
        
        if (index === this.selectedIndex) {
            div.classList.add("selected");
        }
        
        div.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const operator = this.getOperatorFromEvent(e);
            this.onSelect(item, false, operator);
            this.close();
        });
        
        div.addEventListener("mouseover", () => {
            this.selectedIndex = index;
            this.highlightSelected();
        });
    }

    private highlightSelected() {
        const items = this.suggestionsEl.querySelectorAll(".suggestion-item");
        items.forEach((el, i) => {
            el.classList.toggle("selected", i === this.selectedIndex);
        });
    }

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.isVisible) return;
        
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                this.selectedIndex = Math.min(this.selectedIndex + 1, this.suggestions.length - 1);
                this.highlightSelected();
                break;
                
            case "ArrowUp":
                e.preventDefault();
                this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
                this.highlightSelected();
                break;
                
            case "Enter":
                e.preventDefault();
                this.handleEnterPress(e);
                break;
                
            case "Escape":
                this.close();
                break;
        }
    };

    private handleEnterPress(e: KeyboardEvent) {
        const operator = this.getOperatorFromEvent(e);
        
        if (this.selectedIndex >= 0 && this.suggestions[this.selectedIndex]) {
            this.onSelect(this.suggestions[this.selectedIndex], false, operator);
        } else {
            const value = this.inputEl.value.trim();
            if (value) this.onSelect(value, true, operator);
        }
        this.close();
    }

    private getOperatorFromEvent(e: MouseEvent | KeyboardEvent): SearchOperator {
        if (e.ctrlKey && e.shiftKey) return "NOT";
        if (e.shiftKey) return "OR";
        return "AND";
    }

    public close() {
        this.isVisible = false;
        this.selectedIndex = -1;
        this.isDropdownListenerActive = false;
        this.suggestionsEl.classList.add("hidden");
    }
}

/**
 * Main search results view
 */
class SearchResultView extends ItemView {
    private searchResults: SearchResult[] = [];
    private searchInputEl: HTMLInputElement;
    private resultsContainerEl: HTMLElement;
    private suggestionDropdown: SuggestionDropdown | null = null;
    private activeTagsContainerEl: HTMLElement;
    private currentSearchTerms: SearchTerm[] = [];
    private suggestedTagsContainerEl: HTMLElement;
    private propertyButtonsContainerEl: HTMLElement;
    private wasCtrlKeyPressed = false;
    private wasShiftKeyPressed = false;
    private currentSortType: "title" | "modified" | "created" = "title";
    private isSortAscending = true;
    private orOperatorWarningPopup: { popup: HTMLElement; timeout: any } | null = null;
    private dedentBlock(block: string): string { //needed to remove indentation from indented item lists, which otherwise are rendered wrongly in the preview
        const lines = block.split('\n');
        let minIndent = Infinity;

        for (const line of lines) {
            if (line.trim() === '') continue;
            const match = line.match(/^\s*/);
            const indent = match ? match[0].length : 0;
            if (indent < minIndent) minIndent = indent;
        }

        if (minIndent === Infinity) minIndent = 0;
        return lines.map(line => line.substring(minIndent)).join('\n');
    }
    private cleanupTimeouts() {
        if (this.orOperatorWarningPopup) {
            clearTimeout(this.orOperatorWarningPopup.timeout);
        }
    }

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType() { return VIEW_TYPE_SEARCH_RESULTS; }
    getDisplayText() { return "Link Search"; }
    getIcon() { return "search"; }

    async onOpen() {
        this.setupUI();
        this.searchInputEl.focus();
    }

    private setupUI() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.classList.add("search-main-container");

        this.createSearchBar(container);
        this.setupPropertyButtonsContainer();
        this.setupTagsContainer();
        this.setupSuggestedTagsContainer();
        this.setupResultsContainer();
    }

    private createSearchBar(parent: HTMLElement) {
        const searchContainer = createDOMElement(parent, "div", { cls: "search-bar-container" });
        const form = createDOMElement(searchContainer, "form", { cls: "search-bar-form" });

        this.searchInputEl = createDOMElement(form, "input", {
            attributes: {
                type: "text",
                placeholder: "Type a link name and press Enter..."
            },
            cls: "search-input"
        }) as HTMLInputElement;

        this.setupInputListeners(form);
        this.setupDropdown(searchContainer);
    }

    private setupInputListeners(form: HTMLElement) {
        this.searchInputEl.addEventListener("keydown", (e) => {
            this.wasCtrlKeyPressed = e.ctrlKey;
            this.wasShiftKeyPressed = e.shiftKey;
        });

        form.addEventListener("submit", (e) => {
            e.preventDefault();
            this.handleFormSubmit();
        });
    }

    private setupDropdown(searchContainer: HTMLElement) {
        this.suggestionDropdown = new SuggestionDropdown(
            this.app,
            this.searchInputEl,
            searchContainer,
            (value, isTextSearch, operator) => {
                this.addSearchTerm(value, isTextSearch, operator);
                this.searchInputEl.value = "";
                this.suggestionDropdown?.close(); // Explicitly close dropdown after selection
            }
        );
    }

    private handleFormSubmit() {
        const operator = this.getOperatorFromKeys();
        const value = this.searchInputEl.value.trim();
        if (!value) return;

        const files = this.app.vault.getMarkdownFiles();
        const isSuggested = files.some(f => 
            f.basename.toLowerCase() === value.toLowerCase()
        );
        
        this.addSearchTerm(value, !isSuggested, operator);
        this.searchInputEl.value = "";
    }

    private getOperatorFromKeys(): SearchOperator {
        if (this.wasCtrlKeyPressed && this.wasShiftKeyPressed) return "NOT";
        if (this.wasShiftKeyPressed) return "OR";
        return "AND";
    }

    private setupPropertyButtonsContainer() {
        this.propertyButtonsContainerEl = createDOMElement(
            this.containerEl.children[1] as HTMLElement,
            "div",
            { cls: "property-buttons-container" }
        );
    }

    private setupTagsContainer() {
        const activeTagsRow = createDOMElement(
            this.containerEl.children[1] as HTMLElement,
            "div",
            { cls: "tags-row" }
        );
        
        this.activeTagsContainerEl = createDOMElement(
            activeTagsRow,
            "div",
            { cls: "tags-container" }
        );
    }

    private setupSuggestedTagsContainer() {
        const suggestedTagsRow = createDOMElement(
            this.containerEl.children[1] as HTMLElement,
            "div",
            { cls: "suggested-tags-row" }
        );
        
        this.suggestedTagsContainerEl = createDOMElement(
            suggestedTagsRow,
            "div",
            { cls: "suggested-tags-container" }
        );
    }

    private setupResultsContainer() {
        this.resultsContainerEl = createDOMElement(
            this.containerEl.children[1] as HTMLElement,
            "div",
            { cls: "results-container" }
        );
    }

    addSearchTerm(term: string, isTextSearch = false, operator: SearchOperator = "AND") {
        term = term.trim();
        if (!term || this.termExists(term, operator)) return;

        this.currentSearchTerms.push({ term, isTextSearch, operator });
        this.renderSearchTags();
        this.handleOperatorWarning();
        this.executeSearch();
        this.searchInputEl.focus();
    }

    private termExists(term: string, operator: SearchOperator): boolean {
        return this.currentSearchTerms.some(t => 
            t.term === term && t.operator === operator
        );
    }

    private handleOperatorWarning() {
        const orCount = this.currentSearchTerms.filter(t => t.operator === "OR").length;
        
        if (orCount === 1) {
            this.showOrOperatorWarning();
        } else if (orCount === 2 && this.orOperatorWarningPopup) {
            this.hideOrOperatorWarning();
        }
    }

    private renderSearchTags() {
        this.activeTagsContainerEl.empty();
        const operators: SearchOperator[] = ["AND", "OR", "NOT"];
        
        operators.forEach(operator => {
            this.currentSearchTerms
                .filter(t => t.operator === operator)
                .forEach(term => this.createTagElement(term));
        });
    }

    private createTagElement(term: SearchTerm) {
        const wrapper = createDOMElement(this.activeTagsContainerEl, "div", { 
            cls: "search-tag-wrapper"
        });
        
        createDOMElement(wrapper, "div", {
            text: term.operator,
            cls: "search-tag-operator-label"
        });
        
        const displayText = term.term.length > MAX_TAG_LENGTH 
            ? `${term.term.slice(0, MAX_TAG_LENGTH)}\u2026` 
            : term.term;
            
        const tag = createDOMElement(wrapper, "button", {
            text: displayText,
            cls: term.isTextSearch ? "search-tag-text" : "search-tag",
            attributes: { title: term.term }
        });
        
        tag.addEventListener("click", (e) => {
            e.stopPropagation();
            this.removeSearchTerm(term.term, term.operator);
        });
    }

    removeSearchTerm(term: string, operator: SearchOperator) {
        this.currentSearchTerms = this.currentSearchTerms.filter(
            t => !(t.term === term && t.operator === operator)
        );
        this.renderSearchTags();
        this.executeSearch();
        
        if (this.currentSearchTerms.length === 0) {
            this.updateSuggestedTags();
        }
    }

    async executeSearch() {
        if (this.currentSearchTerms.length === 0) {
            this.showMessage("No search terms");
            this.searchResults = [];
            this.updatePropertyButtons();
            this.updateSuggestedTags();
            return;
        }
        
        this.showMessage("Searching...");
        try {
            const blocks = await this.findLinkedBlocksForMultiple(this.currentSearchTerms);
            this.updateSearchResults(blocks);
        } catch (e) {
            this.showMessage(`Error during search: ${(e as Error).message}`);
        }
    }

    async findLinkedBlocksForMultiple(
        targetTerms: SearchTerm[]
    ): Promise<SearchResult[]> {
        // Filter out single OR terms
        targetTerms = this.filterOrphanORTerms(targetTerms);
        
        // Separate terms and property filters
        const { normalTerms, propertyFilters } = this.categorizeTerms(targetTerms);
        const { andTerms, orTerms, notTerms } = this.groupNormalTerms(normalTerms);
        
        // Process files
        const unprocessedResults: BlockResult[] = [];
        const allFiles = this.app.vault.getMarkdownFiles();
        
        for (const file of allFiles) {
            if (!this.filePassesPropertyFilters(file, propertyFilters)) continue;
            
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.sections) continue;
            
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split("\n");
            
            for (const section of cache.sections) {
                if (!section.position) continue;
                this.processSection(section, lines, andTerms, orTerms, notTerms, file, unprocessedResults);
            }
        }
        
        return this.groupResultsByFile(unprocessedResults);
    }

    private filterOrphanORTerms(terms: SearchTerm[]): SearchTerm[] {
        const orCount = terms.filter(t => t.operator === "OR").length;
        return orCount === 1 ? terms.filter(t => t.operator !== "OR") : terms;
    }

    private categorizeTerms(terms: SearchTerm[]) {
        const normalTerms: SearchTerm[] = [];
        const propertyFilters: PropertyFilterMap = { AND: {}, OR: {}, NOT: {} };
        
        for (const term of terms) {
            if (term.term.includes(":") && !term.isTextSearch) {
                const [key, value] = term.term.split(":").map(s => s.trim());
                const operator = term.operator;
                
                if (!propertyFilters[operator][key]) {
                    propertyFilters[operator][key] = new Set();
                }
                propertyFilters[operator][key].add(value);
            } else {
                normalTerms.push(term);
            }
        }
        
        return { normalTerms, propertyFilters };
    }

    private groupNormalTerms(terms: SearchTerm[]) {
        return {
            andTerms: terms.filter(t => t.operator === "AND"),
            orTerms: terms.filter(t => t.operator === "OR"),
            notTerms: terms.filter(t => t.operator === "NOT")
        };
    }

    private filePassesPropertyFilters(file: TFile, filters: PropertyFilterMap): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter || {};
        
        // Check AND filters
        for (const [key, values] of Object.entries(filters.AND)) {
            const propValue = frontmatter[key];
            if (propValue === null || propValue === undefined) return false;
            
            const matches = this.propertyValueMatches(propValue, values);
            if (!matches) return false;
        }
        
        // Check OR filters
        if (Object.keys(filters.OR).length > 0) {
            let anyMatch = false;
            for (const [key, values] of Object.entries(filters.OR)) {
                const propValue = frontmatter[key];
                if (propValue === null || propValue === undefined) continue;
                
                if (this.propertyValueMatches(propValue, values)) {
                    anyMatch = true;
                    break;
                }
            }
            if (!anyMatch) return false;
        }
        
        // Check NOT filters
        for (const [key, values] of Object.entries(filters.NOT)) {
            const propValue = frontmatter[key];
            if (propValue === null || propValue === undefined) continue;
            
            if (this.propertyValueMatches(propValue, values)) return false;
        }
        
        return true;
    }

    private propertyValueMatches(propValue: any, expectedValues: Set<string>): boolean {
        if (Array.isArray(propValue)) {
            return Array.from(expectedValues).some(v => 
                propValue.includes(v)
            );
        }
        return expectedValues.has(propValue.toString());
    }

    private processSection(
        section: any,
        lines: string[],
        andTerms: SearchTerm[],
        orTerms: SearchTerm[],
        notTerms: SearchTerm[],
        file: TFile,
        results: BlockResult[]
    ) {
        const validTypes = ["paragraph", "table", "list", "footnoteDefinition", "callout"];
        if (!validTypes.includes(section.type)) return;
        
        const sectionStart = section.position.start.line;
        const sectionEnd = section.position.end.line;
        
        if (section.type === "list") {
            this.processListSection(section, sectionStart, sectionEnd, lines, andTerms, orTerms, notTerms, file, results);
        } else {
            this.processStandardSection(sectionStart, sectionEnd, lines, andTerms, orTerms, notTerms, file, results);
        }
    }

    private processListSection(
        section: any,
        sectionStart: number,
        sectionEnd: number,
        lines: string[],
        andTerms: SearchTerm[],
        orTerms: SearchTerm[],
        notTerms: SearchTerm[],
        file: TFile,
        results: BlockResult[]
    ) {
        const cache = this.app.metadataCache.getFileCache(file);
        const listItems = cache?.listItems || [];
        
        listItems
            .filter(item => 
                item.position.start.line >= sectionStart && 
                item.position.end.line <= sectionEnd
            )
            .forEach(item => {
                const start = item.position.start.line;
                const end = item.position.end.line;
                const block = lines.slice(start, end + 1).join("\n");
                
                if (this.blockMatchesTerms(block, andTerms, orTerms, notTerms)) {
                    results.push({ content: block, startLine: start, endLine: end, file });
                }
            });
    }

    private processStandardSection(
        start: number,
        end: number,
        lines: string[],
        andTerms: SearchTerm[],
        orTerms: SearchTerm[],
        notTerms: SearchTerm[],
        file: TFile,
        results: BlockResult[]
    ) {
        const block = lines.slice(start, end + 1).join("\n");
        
        if (this.blockMatchesTerms(block, andTerms, orTerms, notTerms)) {
            results.push({ content: block, startLine: start, endLine: end, file });
        }
    }

    private blockMatchesTerms(
        block: string,
        andTerms: SearchTerm[],
        orTerms: SearchTerm[],
        notTerms: SearchTerm[]
    ): boolean {
        const matchesAnd = andTerms.every(term => this.blockMatchesTerm(block, term));
        const matchesOr = orTerms.length === 0 || orTerms.some(term => this.blockMatchesTerm(block, term));
        const matchesNot = notTerms.every(term => !this.blockMatchesTerm(block, term));
        
        return matchesAnd && matchesOr && matchesNot;
    }

    private blockMatchesTerm(block: string, term: SearchTerm): boolean {
        if (term.isTextSearch) {
            return block.toLowerCase().includes(term.term.toLowerCase());
        }
        return extractWikilinks(block)
            .map(link => link.toLowerCase())
            .includes(term.term.toLowerCase());
    }

    private groupResultsByFile(unprocessedResults: BlockResult[]): SearchResult[] {
        const grouped = new Map<string, SearchResult>();
        
        for (const result of unprocessedResults) {
            const key = result.file.path;
            
            if (!grouped.has(key)) {
                grouped.set(key, { file: result.file, blocks: [] });
            }
            
            grouped.get(key)!.blocks.push({
                content: result.content,
                startLine: result.startLine,
                endLine: result.endLine
            });
        }
        
        return Array.from(grouped.values());
    }

    updateSearchResults(results: SearchResult[]) {
        this.searchResults = results;
        this.renderSearchResults();
        this.updatePropertyButtons();
        this.updateSuggestedTags();
    }

    private updatePropertyButtons() {
        if (!this.propertyButtonsContainerEl) return;
        this.propertyButtonsContainerEl.empty();
        if (this.currentSearchTerms.length === 0) return;
        
        const propertiesMap = PropertyUtils.extractProperties(this.searchResults, this.app);
        
        propertiesMap.forEach((values, property) => {
            const button = createDOMElement(this.propertyButtonsContainerEl, "button", {
                cls: "property-button"
            });
            
            const content = createDOMElement(button, "span", { cls: "property-button-content" });
            createDOMElement(content, "span", { text: property, cls: "property-button-text" });
            createDOMElement(content, "span", { text: "↓", cls: "property-button-arrow" });
            
            button.addEventListener("click", (e: MouseEvent) => {
                e.preventDefault();
                this.showPropertyDropdown(button, property, Array.from(values));
            });
        });
        
        const refreshButton = createDOMElement(this.propertyButtonsContainerEl, "button", {
            text: "↻",
            cls: "refresh-button"
        });
        
        refreshButton.addEventListener("click", () => this.executeSearch());
    }

    private showPropertyDropdown(
        button: HTMLElement,
        property: string,
        values: string[]
    ) {
        // Remove existing dropdowns
        this.containerEl.querySelectorAll(".property-dropdown").forEach(el => el.remove());
        
        const dropdown = createDOMElement(this.containerEl, "div", { cls: "property-dropdown" });
        this.positionDropdown(button, dropdown);
        
        values.forEach(value => {
            const item = createDOMElement(dropdown, "div", {
                text: value,
                cls: "property-dropdown-item"
            });
            
            item.addEventListener("click", (e: MouseEvent) => {
                const operator = this.getOperatorFromEvent(e);
                this.addSearchTerm(`${property}:${value}`, false, operator);
                dropdown.remove();
                e.stopPropagation();
            });
        });
        
        this.setupDropdownCloseHandler(dropdown);
    }

    private positionDropdown(button: HTMLElement, dropdown: HTMLElement) {
        const buttonRect = button.getBoundingClientRect();
        const containerRect = this.containerEl.getBoundingClientRect();
        dropdown.style.setProperty("--dropdown-top", `${buttonRect.bottom - containerRect.top + 5}px`);
        dropdown.style.setProperty("--dropdown-left", `${buttonRect.left - containerRect.left}px`);
    }

    private getOperatorFromEvent(e: MouseEvent): SearchOperator {
        if (e.ctrlKey && e.shiftKey) return "NOT";
        if (e.shiftKey) return "OR";
        return "AND";
    }

    private setupDropdownCloseHandler(dropdown: HTMLElement) {
        const clickHandler = (e: MouseEvent) => {
            if (!dropdown.contains(e.target as Node)) {
                dropdown.remove();
                document.removeEventListener("click", clickHandler);
            }
        };
        setTimeout(() => document.addEventListener("click", clickHandler), 0);
    }

    private updateSuggestedTags() {
        if (!this.suggestedTagsContainerEl) return;
        this.suggestedTagsContainerEl.empty();
        if (this.currentSearchTerms.length === 0) return;
        
        createDOMElement(this.suggestedTagsContainerEl, "span", {
            text: "Related links: ",
            cls: "suggested-label"
        });
        
        const filterInput = createDOMElement(this.suggestedTagsContainerEl, "input", {
            attributes: { type: "text", placeholder: "Filter..." },
            cls: "suggested-filter-input"
        }) as HTMLInputElement;
        
        const tagsContainer = createDOMElement(
            this.suggestedTagsContainerEl,
            "div",
            { cls: "suggested-tags-buttons" }
        );
        
        const allLinks = this.collectUniqueLinks();
        this.renderFilteredTags(tagsContainer, allLinks, "");
        
        filterInput.addEventListener("input", () => {
            tagsContainer.empty();
            this.renderFilteredTags(tagsContainer, allLinks, filterInput.value);
        });
    }

    private collectUniqueLinks(): string[] {
        const uniqueLinks = new Set<string>();
        
        this.searchResults.forEach(result => {
            result.blocks.forEach(block => {
                extractWikilinks(block.content).forEach(link => {
                    if (!this.isCurrentSearchTerm(link)) {
                        uniqueLinks.add(link);
                    }
                });
            });
        });
        
        return Array.from(uniqueLinks);
    }

    private isCurrentSearchTerm(link: string): boolean {
        return this.currentSearchTerms.some(
            term => term.term.toLowerCase() === link.toLowerCase()
        );
    }

    private renderFilteredTags(container: HTMLElement, links: string[], filter: string) {
        const filtered = links.filter(link => 
            link.toLowerCase().includes(filter.toLowerCase())
        );
        
        filtered.forEach(link => {
            const displayText = link.length > MAX_TAG_LENGTH 
                ? `${link.slice(0, MAX_TAG_LENGTH)}\u2026` 
                : link;
                
            const tagButton = createDOMElement(container, "button", {
                text: displayText,
                cls: "suggested-tag",
                attributes: { title: link }
            });
            
            tagButton.addEventListener("click", (e: MouseEvent) => {
                const operator = this.getOperatorFromEvent(e);
                this.addSearchTerm(link, false, operator);
            });
        });
    }

    showMessage(message: string) {
        this.resultsContainerEl.empty();
        createDOMElement(this.resultsContainerEl, "p", { text: message });
    }

    async renderSearchResults() {
        this.resultsContainerEl.empty();
        if (this.searchResults.length === 0) {
            createDOMElement(this.resultsContainerEl, "p", { text: "No matches found." });
            return;
        }
        
        this.renderResultsHeader();
        await this.renderResultsContent();
    }

    private renderResultsHeader() {
        const headerRow = createDOMElement(this.resultsContainerEl, "div", {
            cls: "search-header-row"
        });
        
        const totalBlocks = this.searchResults.reduce((sum, r) => sum + r.blocks.length, 0);
        const totalNotes = this.searchResults.length;
        
        createDOMElement(headerRow, "div", {
            text: `Found ${totalBlocks} result${totalBlocks !== 1 ? "s" : ""} in ${totalNotes} note${totalNotes !== 1 ? "s" : ""}`,
            cls: "search-summary"
        });
        
        const sortContainer = createDOMElement(headerRow, "div", {
            cls: "search-sort-container"
        });
        
        createDOMElement(sortContainer, "span", {
            text: "Sort by:",
            cls: "sort-label"
        });
        
        const sortSelect = createDOMElement(sortContainer, "select", {
            cls: "sort-select"
        }) as HTMLSelectElement;
        
        SORT_OPTIONS.forEach(opt => {
            const option = createDOMElement(sortSelect, "option", {
                text: opt.label,
                attributes: { value: opt.value }
            }) as HTMLOptionElement;
            option.selected = opt.value === this.currentSortType;
        });
        
        const arrow = createDOMElement(sortContainer, "span", {
            text: this.isSortAscending ? "↑" : "↓",
            cls: "sort-arrow"
        });
        
        arrow.title = "Toggle sort order";
        sortSelect.addEventListener("change", () => {
            this.currentSortType = sortSelect.value as any;
            this.renderSearchResults();
        });
        
        arrow.addEventListener("click", () => {
            this.isSortAscending = !this.isSortAscending;
            arrow.textContent = this.isSortAscending ? "↑" : "↓";
            this.renderSearchResults();
        });
    }

    private async renderResultsContent() {
        const sortedResults = this.getSortedResults();
        
        for (const result of sortedResults) {
            const fileHeader = createDOMElement(this.resultsContainerEl, "div", {
                cls: "search-result-file"
            });
            
            const headerContent = createDOMElement(fileHeader, "div", {
                cls: "file-header-content"
            });
            
            const fileName = createDOMElement(headerContent, "h4", {
                text: result.file.basename
            });
            
            fileName.addEventListener("click", () => {
                this.app.workspace.openLinkText(result.file.path, "");
            });
            
            for (const block of result.blocks) {
                await this.renderBlockContent(result.file, block);
            }
        }
    }

    private getSortedResults(): SearchResult[] {
        return [...this.searchResults].sort((a, b) => {
            if (this.currentSortType === "title") {
                return this.isSortAscending 
                    ? a.file.basename.localeCompare(b.file.basename)
                    : b.file.basename.localeCompare(a.file.basename);
            }
            
            const timeA = this.currentSortType === "modified" 
                ? a.file.stat.mtime 
                : a.file.stat.ctime;
                
            const timeB = this.currentSortType === "modified" 
                ? b.file.stat.mtime 
                : b.file.stat.ctime;
                
            return this.isSortAscending 
                ? timeA - timeB 
                : timeB - timeA;
        });
    }

    private async renderBlockContent(file: TFile, block: SearchResultBlock) {
        const blockContainer = createDOMElement(this.resultsContainerEl, "div", {
            cls: "block-container"
        });
        
        const contentContainer = createDOMElement(blockContainer, "div", {
            cls: "block-content-container"
        });
        
        const blockContent = createDOMElement(contentContainer, "div", {
            cls: "block-content"
        });
        
        const fileContent = await this.app.vault.read(file);
        const lines = fileContent.split("\n");
        const contentToRender = lines.slice(block.startLine, block.endLine + 1).join("\n");
        const dedentedContent = this.dedentBlock(contentToRender);
        
        MarkdownRenderer.render(
            this.app,
            dedentedContent,
            blockContent,
            file.path,
            this
        );
        
        this.addBlockActions(blockContainer, file, block);
    }

    private addBlockActions(container: HTMLElement, file: TFile, block: SearchResultBlock) {
        const linkContainer = createDOMElement(container, "div", {
            cls: "block-link-container"
        });
        
        const copyIcon = createDOMElement(linkContainer, "a", {
            cls: "block-action",
            attributes: { 
                href: "#", 
                title: "Copy block content" 
            },
            text: "📋"
        });
        
        copyIcon.addEventListener("click", (e) => {
            e.preventDefault();
            navigator.clipboard.writeText(block.content);
            new Notice("Block content copied to clipboard");
        });
        
        const linkIcon = createDOMElement(linkContainer, "a", {
            cls: "block-action",
            attributes: { 
                href: "#", 
                title: "Open link" 
            },
            text: "🔗"
        });
        
        linkIcon.addEventListener("click", (e) => {
            e.preventDefault();
            this.openBlockInEditor(file, block);
        });
    }

    async openBlockInEditor(
        file: TFile,
        block: SearchResultBlock
    ) {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
        
        if (leaf.view instanceof MarkdownView) {
            const editor = leaf.view.editor;
            const content = await this.app.vault.read(file);
            const lines = content.split("\n");
            const targetLine = this.determineTargetLine(lines, block);
            
            editor.setCursor({ line: targetLine, ch: 0 });
            editor.scrollIntoView(
                {
                    from: { line: Math.max(0, targetLine - 3), ch: 0 },
                    to: { line: block.endLine + 3, ch: 0 },
                },
                true
            );
            this.highlightEditorBlock(editor, block.startLine, block.endLine);
        }
    }

    private determineTargetLine(lines: string[], block: SearchResultBlock): number {
        const blockLines = lines.slice(block.startLine, block.endLine + 1);
        
        if (blockLines.every(line => line.trim().startsWith("|"))) {
            for (let i = block.startLine; i <= block.endLine; i++) {
                if (lines[i].trim().startsWith("|")) return i;
            }
        }
        return block.startLine;
    }

    highlightEditorBlock(editor: Editor, startLine: number, endLine: number) {
        const cm = (editor as any).cm;
        if (!cm || typeof cm.getAllMarks !== "function") return;
        
        cm.getAllMarks().forEach((mark: any) => mark.clear());
        
        const startPos = { line: startLine, ch: 0 };
        const endPos = { line: endLine, ch: editor.getLine(endLine).length };
        
        const highlight = cm.markText(startPos, endPos, {
            className: "block-highlight",
        });
        
        setTimeout(() => highlight.clear(), HIGHLIGHT_DURATION);
    }

    private showOrOperatorWarning() {
        this.hideOrOperatorWarning();
        
        const tagButtons = this.activeTagsContainerEl.querySelectorAll('.search-tag-wrapper');
        const lastOr = Array.from(tagButtons).find(div => 
            div.querySelector('.search-tag-operator-label')?.textContent === "OR"
        );
        
        if (!lastOr) return;
        
        const popup = createDOMElement(document.body, "div", {
            text: "OR operator needs at least two search terms to work",
            cls: "or-operator-warning"
        });
        
        const rect = lastOr.getBoundingClientRect();
        popup.style.setProperty("--warning-left", `${rect.left + window.scrollX}px`);
        popup.style.setProperty("--warning-top", `${rect.top + window.scrollY - 38}px`);
        
        this.orOperatorWarningPopup = {
            popup,
            timeout: setTimeout(() => this.hideOrOperatorWarning(), OR_WARNING_DURATION)
        };
    }

    private hideOrOperatorWarning() {
        if (this.orOperatorWarningPopup) {
            clearTimeout(this.orOperatorWarningPopup.timeout);
            this.orOperatorWarningPopup.popup.remove();
            this.orOperatorWarningPopup = null;
        }
    }
    async onClose() {
        if (this.suggestionDropdown) {
            this.suggestionDropdown.destroy();
        }
        this.hideOrOperatorWarning();
        this.cleanupTimeouts();
    }
}

export default class SearchPlugin extends Plugin {
    async onload() {
        this.registerView(
            VIEW_TYPE_SEARCH_RESULTS,
            leaf => new SearchResultView(leaf)
        );
        
        this.addCommand({
            id: "open-search-view",
            name: "Open Search Panel",
            callback: () => this.activateView()
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
}