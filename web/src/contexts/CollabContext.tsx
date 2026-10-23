// src/contexts/CollabContext.tsx
import type React from 'react';
import {
	type ReactNode,
	createContext,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type * as Y from 'yjs';

import { createNamedLogger } from '@/logging';
import { collabService } from '../services/CollabService';
import type { CollabContextType } from '../types/collab';
import type { YjsDocUrl } from '../types/yjs';

const moduleLog = createNamedLogger('CollabContext');

export const CollabContext = createContext<CollabContextType | null>(null);

interface CollabProviderProps {
	children: ReactNode;
	docUrl: YjsDocUrl;
	collectionName: string;
}

export const CollabProvider: React.FC<CollabProviderProps> = ({
	children,
	docUrl,
	collectionName,
}) => {
	const [data, setData] = useState<any>(undefined);
	const [isConnected, setIsConnected] = useState(false);
	const [doc, setDoc] = useState<Y.Doc | undefined>();
	const isUpdatingRef = useRef(false);

	const projectId = useMemo(() => {
		return docUrl.startsWith('yjs:')
			? docUrl.slice(4)
			: docUrl.replace(/[^a-zA-Z0-9]/g, '-');
	}, [docUrl]);

	useEffect(() => {
		if (!projectId || !collectionName) return;

		try {
			// Local-only: no provider, no signaling. The Yjs document is
			// persisted to IndexedDB and shared in memory for open editors.
			const { doc: ydoc } = collabService.connect(projectId, collectionName);
			setDoc(ydoc);

			const ymap = ydoc.getMap('data');

			const observer = () => {
				if (!isUpdatingRef.current) {
					setData(ymap.toJSON());
				}
			};

			ymap.observe(observer);
			setData(ymap.toJSON());
			setIsConnected(true);

			return () => {
				ymap.unobserve(observer);
				collabService.disconnect(projectId, collectionName);
				setIsConnected(false);
				setDoc(undefined);
			};
		} catch (error) {
			moduleLog.warn('Local document open failed:', error);
			setIsConnected(false);
			setDoc(undefined);
			return () => {};
		}
	}, [projectId, collectionName]);

	const changeData = useCallback(
		(fn: (currentData: any) => void) => {
			if (!doc) return;

			const ymap = doc.getMap('data');
			isUpdatingRef.current = true;

			doc.transact(() => {
				const currentData = ymap.toJSON();
				fn(currentData);

				for (const key of ymap.keys()) {
					ymap.delete(key);
				}
				if (typeof currentData === 'object' && currentData !== null) {
					Object.entries(currentData).forEach(([key, value]) => {
						ymap.set(key, value);
					});
				}
			});

			setData(ymap.toJSON());

			isUpdatingRef.current = false;
		},
		[doc],
	);

	const getAwareness = useCallback(
		(collectionName: string) =>
			collabService.getAwareness(projectId, collectionName),
		[projectId],
	);

	const value: CollabContextType<any> = {
		collabService,
		doc,
		provider: undefined,
		data,
		changeData,
		isConnected,
		getAwareness,
	};

	return (
		<CollabContext.Provider value={value}>{children}</CollabContext.Provider>
	);
};
