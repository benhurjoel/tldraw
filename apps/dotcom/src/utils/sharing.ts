import {
	AssetRecordType,
	Editor,
	SerializedSchema,
	SerializedStore,
	TLAsset,
	TLAssetId,
	TLRecord,
	TLShape,
	TLShapeId,
	TLUiEventHandler,
	TLUiOverrides,
	TLUiToastsContextType,
	TLUiTranslationKey,
	assert,
	findMenuItem,
	isShape,
	menuGroup,
	menuItem,
} from '@tldraw/tldraw'
import { useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMultiplayerAssets } from '../hooks/useMultiplayerAssets'
import { getViewportUrlQuery } from '../hooks/useUrlState'
import { cloneAssetForShare } from './cloneAssetForShare'
import { ASSET_UPLOADER_URL } from './config'
import { shouldLeaveSharedProject } from './shouldLeaveSharedProject'
import { trackAnalyticsEvent } from './trackAnalyticsEvent'
import { UI_OVERRIDE_TODO_EVENT, useHandleUiEvents } from './useHandleUiEvent'

export const SHARE_PROJECT_ACTION = 'share-project' as const
export const SHARE_SNAPSHOT_ACTION = 'share-snapshot' as const
const LEAVE_SHARED_PROJECT_ACTION = 'leave-shared-project' as const
export const FORK_PROJECT_ACTION = 'fork-project' as const
const CREATE_SNAPSHOT_ENDPOINT = `/api/snapshots`
const SNAPSHOT_UPLOAD_URL = `/api/new-room`

type SnapshotRequestBody = {
	schema: SerializedSchema
	snapshot: SerializedStore<TLRecord>
}

type CreateSnapshotRequestBody = {
	schema: SerializedSchema
	snapshot: SerializedStore<TLRecord>
	parent_slug?: string | string[] | undefined
}

type CreateSnapshotResponseBody =
	| {
			error: false
			roomId: string
	  }
	| {
			error: true
			message: string
	  }

async function getSnapshotLink(
	source: string,
	editor: Editor,
	handleUiEvent: TLUiEventHandler,
	addToast: TLUiToastsContextType['addToast'],
	msg: (id: TLUiTranslationKey) => string,
	uploadFileToAsset: (file: File) => Promise<TLAsset>,
	parentSlug: string | undefined
) {
	handleUiEvent('share-snapshot' as UI_OVERRIDE_TODO_EVENT, { source } as UI_OVERRIDE_TODO_EVENT)
	const data = await getRoomData(editor, addToast, msg, uploadFileToAsset)
	if (!data) return ''

	const res = await fetch(CREATE_SNAPSHOT_ENDPOINT, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			snapshot: data,
			schema: editor.store.schema.serialize(),
			parent_slug: parentSlug,
		} satisfies CreateSnapshotRequestBody),
	})
	const response = (await res.json()) as CreateSnapshotResponseBody

	if (!res.ok || response.error) {
		console.error(await res.text())
		return ''
	}
	const paramsToUse = getViewportUrlQuery(editor)
	const params = paramsToUse ? `?${new URLSearchParams(paramsToUse).toString()}` : ''
	return new Blob([`${window.location.origin}/s/${response.roomId}${params}`], {
		type: 'text/plain',
	})
}

export function useSharing({ isMultiplayer }: { isMultiplayer: boolean }): TLUiOverrides {
	const navigate = useNavigate()
	const id = useSearchParams()[0].get('id') ?? undefined
	const uploadFileToAsset = useMultiplayerAssets(ASSET_UPLOADER_URL)
	const handleUiEvent = useHandleUiEvents()

	return useMemo(
		(): TLUiOverrides => ({
			actions(editor, actions, { addToast, msg, addDialog }) {
				actions[LEAVE_SHARED_PROJECT_ACTION] = {
					id: LEAVE_SHARED_PROJECT_ACTION,
					label: 'action.leave-shared-project',
					readonlyOk: true,
					onSelect: async () => {
						const shouldLeave = await shouldLeaveSharedProject(addDialog)
						if (!shouldLeave) return

						handleUiEvent('leave-shared-project', {})

						navigate('/')
					},
				}
				actions[SHARE_PROJECT_ACTION] = {
					id: SHARE_PROJECT_ACTION,
					label: 'action.share-project',
					readonlyOk: true,
					onSelect: async (source) => {
						try {
							handleUiEvent('share-project', { source })
							const data = await getRoomData(editor, addToast, msg, uploadFileToAsset)
							if (!data) return

							const res = await fetch(SNAPSHOT_UPLOAD_URL, {
								method: 'POST',
								headers: {
									'Content-Type': 'application/json',
								},
								body: JSON.stringify({
									schema: editor.store.schema.serialize(),
									snapshot: data,
								} satisfies SnapshotRequestBody),
							})

							const response = (await res.json()) as { error: boolean; slug?: string }
							if (!res.ok || response.error) {
								console.error(await res.text())
								throw new Error('Failed to upload snapshot')
							}

							const query = getViewportUrlQuery(editor)

							navigate(`/r/${response.slug}?${new URLSearchParams(query ?? {}).toString()}`)
						} catch (error) {
							console.error(error)
							addToast({
								title: 'Error',
								description: msg('share-menu.upload-failed'),
							})
						}
					},
				}
				actions[SHARE_SNAPSHOT_ACTION] = {
					id: SHARE_SNAPSHOT_ACTION,
					label: 'share-menu.create-snapshot-link',
					readonlyOk: true,
					onSelect: async (source) => {
						const result = getSnapshotLink(
							source,
							editor,
							handleUiEvent,
							addToast,
							msg,
							uploadFileToAsset,
							id
						)
						if (navigator?.clipboard?.write) {
							await navigator.clipboard.write([
								new ClipboardItem({
									'text/plain': result,
								}),
							])
						} else if (navigator?.clipboard?.writeText) {
							const link = await result
							if (link === '') return
							navigator.clipboard.writeText(await link.text())
						}
					},
				}
				actions[FORK_PROJECT_ACTION] = {
					...actions[SHARE_PROJECT_ACTION],
					id: FORK_PROJECT_ACTION,
					label: 'action.fork-project',
				}
				return actions
			},
			menu(editor, menu, { actions }) {
				const fileMenu = findMenuItem(menu, ['menu', 'file'])
				assert(fileMenu.type === 'submenu')
				if (isMultiplayer) {
					fileMenu.children.unshift(
						menuGroup(
							'share',
							menuItem(actions[FORK_PROJECT_ACTION]),
							menuItem(actions[LEAVE_SHARED_PROJECT_ACTION])
						)!
					)
				} else {
					fileMenu.children.unshift(menuGroup('share', menuItem(actions[SHARE_PROJECT_ACTION]))!)
				}
				return menu
			},
		}),
		[handleUiEvent, navigate, uploadFileToAsset, id, isMultiplayer]
	)
}

async function getRoomData(
	editor: Editor,
	addToast: TLUiToastsContextType['addToast'],
	msg: (id: TLUiTranslationKey) => string,
	uploadFileToAsset: (file: File) => Promise<TLAsset>
) {
	const rawData = editor.store.serialize()

	// rawData contains a cache of previously added assets,
	// which we don't want included in the shared document.
	// So let's strip it out.

	// our final object that holds the data that we'll persist to a stash
	const data: Record<string, TLRecord> = {}

	// let's get all the assets/shapes in data
	const shapes = new Map<TLShapeId, TLShape>()
	const assets = new Map<TLAssetId, TLAsset>()

	for (const record of Object.values(rawData)) {
		if (AssetRecordType.isInstance(record)) {
			// collect assets separately, don't add them to the proper doc yet
			assets.set(record.id, record)
			continue
		}
		data[record.id] = record
		if (isShape(record)) {
			shapes.set(record.id, record)
		}
	}

	// now add only those assets that are referenced in shapes
	for (const shape of shapes.values()) {
		if ('assetId' in shape.props) {
			const asset = assets.get(shape.props.assetId as TLAssetId)
			// if we can't find the asset it either means
			// somethings gone wrong or we've already
			// processed it
			if (!asset) continue

			data[asset.id] = await cloneAssetForShare(asset, uploadFileToAsset)
			// remove the asset after processing so we don't clone it multiple times
			assets.delete(asset.id)
		}
	}

	const size = new Blob([JSON.stringify(data)]).size

	if (size > 3999999) {
		addToast({
			title: 'Too big!',
			description: msg('share-menu.project-too-large'),
		})

		trackAnalyticsEvent('shared-fail-too-big', {
			size: size.toString(),
		})

		return null
	}
	return data
}
