import {
  prepareNameSearchItems,
  prepareSearchItem,
  rankPreparedNamesTopK,
  rankPreparedTopK,
  type PreparedNameSearchIndex,
  type PreparedSearchItem,
} from '../utils/channel-search';
import type {
  SearchIndexRequest,
  SearchIndexResponse,
  SearchCatalogDocument,
  SearchQueryRequest,
  SearchQueryResponse,
  SearchRankedDocuments,
  SearchRankedIndices,
  SharedChannelSearchRequest,
} from './tasks';

interface IndexedName {
  id: string;
  name: string;
}

export class SearchWorkerIndex {
  private sessionId: number | null = null;
  private channels: PreparedSearchItem<number>[] = [];
  private channelNames: PreparedNameSearchIndex<IndexedName> = { items: [], values: [] };
  private channelRevision: number | null = null;
  private programmes: PreparedSearchItem<number>[] = [];
  private localMovies: SearchCatalogDocument[] = [];
  private localSeries: SearchCatalogDocument[] = [];
  private remoteMovies: SearchCatalogDocument[] = [];
  private remoteSeries: SearchCatalogDocument[] = [];
  private movies: PreparedNameSearchIndex<IndexedName> = { items: [], values: [] };
  private series: PreparedNameSearchIndex<IndexedName> = { items: [], values: [] };

  index(request: SearchIndexRequest): SearchIndexResponse {
    if (request.reset) {
      this.sessionId = request.sessionId;
      this.channels = [];
      this.channelNames = { items: [], values: [] };
      this.channelRevision = null;
      this.programmes = [];
      this.localMovies = [];
      this.localSeries = [];
      this.remoteMovies = [];
      this.remoteSeries = [];
      this.movies = { items: [], values: [] };
      this.series = { items: [], values: [] };
    } else if (request.sessionId !== this.sessionId) {
      return { accepted: false };
    }

    if (request.channels) {
      this.channels = prepareFields(request.channels);
      this.channelNames = prepareNameSearchItems(request.channels.map((fields, index) => ({
        id: String(index),
        name: fields[0] ?? '',
      })));
      this.channelRevision = request.channelRevision ?? null;
    }
    if (request.programmes) this.programmes = prepareFields(request.programmes);
    if (request.localMovieIndices) {
      this.localMovies = localCatalogDocuments(request.channels, request.localMovieIndices);
    }
    if (request.localSeriesIndices) {
      this.localSeries = localCatalogDocuments(request.channels, request.localSeriesIndices);
    }
    if (request.localMovieIndices || request.localSeriesIndices) this.rebuildCatalog();
    return { accepted: true };
  }

  catalog(
    sessionId: number,
    movies: SearchCatalogDocument[],
    series: SearchCatalogDocument[],
  ): SearchIndexResponse {
    if (sessionId !== this.sessionId) return { accepted: false };
    this.remoteMovies = movies;
    this.remoteSeries = series;
    this.rebuildCatalog();
    return { accepted: true };
  }

  private rebuildCatalog(): void {
    this.movies = prepareNames(this.localMovies.concat(this.remoteMovies));
    this.series = prepareNames(this.localSeries.concat(this.remoteSeries));
  }

  query(request: SearchQueryRequest): SearchQueryResponse | null {
    if (request.sessionId !== this.sessionId) return null;
    return {
      channels: rankedFields(this.channels, request.query, request.limit),
      programmes: rankedFields(this.programmes, request.query, request.limit),
      movies: request.includeCatalog
        ? rankedNames(this.movies, request.query, request.limit)
        : emptyResult(),
      series: request.includeCatalog
        ? rankedNames(this.series, request.query, request.limit)
        : emptyResult(),
    };
  }

  queryChannels(request: SharedChannelSearchRequest): SearchRankedIndices | null {
    if (this.channelRevision !== request.channelRevision
        || this.channels.length !== request.channelCount) return null;
    if (request.mode === 'names') {
      const result = rankPreparedNamesTopK(
        this.channelNames,
        request.query,
        request.limit,
      );
      return {
        indices: result.items.map(item => Number(item.id)),
        hasMore: result.hasMore,
      };
    }
    return rankedFields(this.channels, request.query, request.limit);
  }
}

function prepareFields(documents: string[][]): PreparedSearchItem<number>[] {
  return documents.map((fields, index) => prepareSearchItem(index, () => fields));
}

function prepareNames(documents: SearchCatalogDocument[]): PreparedNameSearchIndex<IndexedName> {
  return prepareNameSearchItems(documents);
}

function localCatalogDocuments(
  channels: string[][] | undefined,
  indices: number[],
): SearchCatalogDocument[] {
  if (!channels) return [];
  const documents: SearchCatalogDocument[] = [];
  for (const index of indices) {
    const fields = channels[index];
    if (fields) documents.push({ id: `m3u:${String(index)}`, name: fields[0] ?? '' });
  }
  return documents;
}

function rankedFields(
  index: PreparedSearchItem<number>[],
  query: string,
  limit: number,
): SearchRankedIndices {
  const result = rankPreparedTopK(index, query, limit);
  return { indices: result.items, hasMore: result.hasMore };
}

function rankedNames(
  index: PreparedNameSearchIndex<IndexedName>,
  query: string,
  limit: number,
): SearchRankedDocuments {
  const result = rankPreparedNamesTopK(index, query, limit);
  return {
    documents: result.items.map(item => ({ id: item.id, name: item.name })),
    hasMore: result.hasMore,
  };
}

function emptyResult(): SearchRankedDocuments {
  return { documents: [], hasMore: false };
}
