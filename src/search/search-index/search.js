import {
    structureSearchResult,
    initLookupByKeys,
    keyGen,
    rangeLookup,
    removeKeyType,
} from './util'

const lookupByKeys = initLookupByKeys()

const compareByScore = (a, b) => b.score - a.score

// TODO: If only the page state changes, re-use results from last search
const paginate = ({ skip, limit }) => results =>
    results.slice(skip, skip + limit)

async function filterSearch({ timeFilter }) {
    // Exit early for no values
    if (!timeFilter.size) {
        return null
    }

    const data = []

    for (const timeRange of timeFilter.values()) {
        data.push(await rangeLookup(timeRange))
    }

    // Perform union of results between all filter types (for now)
    const unionedResults = new Map([
        ...data.reduce((acc, curr) => [...acc, ...curr], []),
    ])

    //  Createa  Map of page ID keys to weights
    return new Map(
        [...unionedResults].reduce((acc, [timeKey, pageMap]) => {
            const time = removeKeyType(timeKey)

            // Update each page `latest` stamp for scoring with latest of all hits
            for (const [pageId, props] of pageMap) {
                if (!props.latest || props.latest < time) {
                    pageMap.set(pageId, { ...props, latest: time })
                }
            }
            return [...acc, ...pageMap]
        }, []),
    )
}

async function termSearch({ query }) {
    // Exit early for wildcard
    if (!query.size) {
        return null
    }

    // For each term, do index lookup to grab the associated page IDs value
    const termValuesMap = await lookupByKeys([...query].map(keyGen.term))

    // If any terms are empty, they cancel all other results out
    const containsEmptyTerm = [...termValuesMap.values()].reduce(
        (acc, curr) => acc || curr == null || !curr.size,
        false,
    )

    // Exit early if no results
    if (!termValuesMap.size || containsEmptyTerm) {
        return new Map()
    }

    // Create a Map of page ID keys to weights
    const pageValuesMap = new Map(
        [...termValuesMap.values()].reduce(
            (acc, curr) => [...acc, ...curr],
            [],
        ),
    )

    // Perform intersect of Map on each term value key to AND results
    if (termValuesMap.size > 1) {
        const missingInSomeTermValues = terms => pageId =>
            terms.some(termValue => !termValue.has(pageId))

        // Perform set difference on pageIds between termValues
        const differedIds = new Set(
            [...pageValuesMap.keys()].filter(
                missingInSomeTermValues([...termValuesMap.values()]),
            ),
        )

        // Delete each of the differed pageIds from the merged Map of term values
        differedIds.forEach(pageId => pageValuesMap.delete(pageId))
    }

    return pageValuesMap
}

function formatIdResults(pageResultsMap) {
    const results = []

    for (const [pageId, value] of pageResultsMap) {
        results.push(structureSearchResult({ id: pageId }, value.latest))
    }

    return results.sort(compareByScore)
}

async function resolveIdResults(pageResultsMap) {
    const pageValuesMap = await lookupByKeys([...pageResultsMap.keys()])

    const results = []

    for (const [pageId, props] of pageValuesMap) {
        const { latest } = pageResultsMap.get(pageId)
        results.push(structureSearchResult(props, latest))
    }

    return results.sort(compareByScore)
}

function intersectResultMaps(termPages, filterPages) {
    // Should be null if filter search not needed to be run
    if (filterPages == null) {
        return termPages
    }
    if (termPages == null) {
        return filterPages
    }

    const intersectsTermPages = ([filterPage]) => termPages.has(filterPage)

    return new Map([...filterPages].filter(intersectsTermPages))
}

/**
 * Performs a search based on data supplied in the `query`.
 *
 * @param {IndexQuery} query
 * @param {boolean} [fullDocs=true] Specifies whether to return just the ID or all doc data.
 * @returns {SearchResult[]}
 */
export async function search(
    query = { skip: 0, limit: 10 },
    { fullDocs = true, count = false } = { fullDocs: true, count: false },
) {
    const paginateResults = paginate(query)
    let totalResultCount
    console.time('total search')

    console.time('term search')
    const termPageResultsMap = await termSearch(query)
    console.timeEnd('term search')

    console.time('filter search')
    const filterPageResultsMap = await filterSearch(query)
    console.timeEnd('filter search')

    // If there was a time filter applied, intersect those results with term results, else use term results
    const pageResultsMap = intersectResultMaps(
        termPageResultsMap,
        filterPageResultsMap,
    )

    if (count) {
        totalResultCount = pageResultsMap.size
    }

    // Either or resolve result IDs to their indexed doc data, or just return the IDs map
    const results = fullDocs
        ? await resolveIdResults(pageResultsMap)
        : formatIdResults(pageResultsMap)

    console.timeEnd('total search')
    return {
        results: paginateResults(results),
        totalCount: totalResultCount,
    }
}
