import * as Collections from 'typescript-collections';

import { Guid } from '@/script/types/Guid';
import Command from './libs/three/Command';
import SpawnBlueprintCommand from './commands/SpawnBlueprintCommand';
import BulkCommand from './commands/BulkCommand';
import DestroyBlueprintCommand from './commands/DestroyBlueprintCommand';
import History from './libs/three/History';
import GameContext from './modules/GameContext';
import VEXTInterface from './modules/VEXT';

import { GameObjectParentData } from './types/GameObjectParentData';
import { BlueprintManager } from './modules/BlueprintManager';
import { EditorUI } from './modules/EditorUI';
import { SelectionGroup } from './types/SelectionGroup';
import { Config } from './modules/Config';
import { Blueprint } from './types/Blueprint';
import { GIZMO_MODE, THREEManager } from './modules/THREEManager';
import { EditorCore } from './EditorCore';
import { SpatialGameEntity } from './types/SpatialGameEntity';
import { CommandActionResult } from './types/CommandActionResult';
import { HighlightGroup } from './types/HighlightGroup';
import { GameObjectTransferData } from './types/GameObjectTransferData';
import { GameObject } from './types/GameObject';
import { FrostbiteDataManager } from './modules/FrostbiteDataManager';
import { LinearTransform } from './types/primitives/LinearTransform';
import { Vec3 } from './types/primitives/Vec3';
import { signals } from '@/script/modules/Signals';
import { LogError, LOGLEVEL } from '@/script/modules/Logger';
import { GenerateBlueprints } from '@/script/modules/DebugData';

export default class Editor {
	public config = new Config();
	public editorCore = new EditorCore();
	public debug = false;
	public threeManager: THREEManager;
	public ui = new EditorUI(this.debug);
	public vext = new VEXTInterface();
	public history = new History(this);
	public blueprintManager = new BlueprintManager();
	public gameContext = new GameContext();
	public fbdMan = new FrostbiteDataManager();

	public playerName: string;
	public gameObjects = new Collections.Dictionary<Guid, GameObject>();
	public favorites = new Collections.Dictionary<Guid, Blueprint>();
	public copy: SpawnBlueprintCommand[];

	public selectionGroup: SelectionGroup;
	public highlightGroup: HighlightGroup;
	public missingParent: Collections.Dictionary<Guid, GameObject[]>;

	public selectedGameObjects: GameObject[] = [];

	constructor(debug: boolean = false) {
		// Commands
		signals.editor.Ready.connect(this.onEditorReady.bind(this));
		signals.spawnedBlueprint.connect(this.onSpawnedBlueprint.bind(this));
		signals.blueprintSpawnInvoked.connect(this.onBlueprintSpawnInvoked.bind(this));
		signals.enabledBlueprint.connect(this.onEnabledBlueprint.bind(this));
		signals.disabledBlueprint.connect(this.onDisabledBlueprint.bind(this));

		signals.destroyedBlueprint.connect(this.onDestroyedBlueprint.bind(this));
		signals.setObjectName.connect(this.onSetObjectName.bind(this));
		signals.setTransform.connect(this.onSetTransform.bind(this));
		signals.setVariation.connect(this.onSetVariation.bind(this));

		// Messages

		signals.objectChanged.connect(this.onObjectChanged.bind(this));

		this.debug = debug;
		this.threeManager = new THREEManager(debug);

		/*

			Internal variables

		 */
		// this.selected = [];

		this.playerName = '';

		this.copy = [];

		// Creates selection and highlighting group and adds them to the scene
		this.selectionGroup = new SelectionGroup(false);
		this.highlightGroup = new HighlightGroup();

		this.missingParent = new Collections.Dictionary<Guid, GameObject[]>();
		this.Initialize();
	}

	public Initialize() {
		const scope = this;
		signals.editor.Initializing.emit(true);
		// Adds the chrome background and debug window
		if (this.debug === true) {
			this.setPlayerName('LocalPlayer');
		}
	}

	public onEditorReady() {
		signals.menuRegistered.emit(['File', 'New'], this.NotImplemented.bind(this));
		signals.menuRegistered.emit(['File', 'Open'], this.NotImplemented.bind(this));
		signals.menuRegistered.emit(['File', 'Import', 'From file'], this.NotImplemented.bind(this));
		signals.menuRegistered.emit(['File', 'Import', 'From level'], this.NotImplemented.bind(this));

		signals.menuRegistered.emit(['Edit', 'Undo'], this.undo.bind(this));
		signals.menuRegistered.emit(['Edit', 'Redo'], this.redo.bind(this));
		signals.menuRegistered.emit(['Edit', '']); // Separator
		signals.menuRegistered.emit(['Edit', 'Cut'], this.Cut.bind(this));
		signals.menuRegistered.emit(['Edit', 'Copy'], this.Copy.bind(this));
		signals.menuRegistered.emit(['Edit', 'Paste'], this.Paste.bind(this));
		signals.menuRegistered.emit(['Edit', '']); // Separator
		signals.menuRegistered.emit(['Edit', 'Duplicate'], this.Duplicate.bind(this));
		signals.menuRegistered.emit(['Edit', 'Delete'], this.DeleteSelected.bind(this));
		signals.menuRegistered.emit(['Edit', '']); // Separator
		if (this.debug) {
			this.blueprintManager.RegisterBlueprints(JSON.stringify(GenerateBlueprints(100)));
		} else {
			this.vext.SendEvent('UIReloaded');
			console.log('Sent event');
		}
	}

	private NotImplemented() {
		console.error('Not implemented');
	}

	public setPlayerName(name: string) {
		if (name === undefined) {
			window.LogError('Failed to set player name');
		} else {
			this.playerName = name;
		}
	}

	public getPlayerName() {
		return this.playerName;
	}

	public AddFavorite(blueprint: Blueprint) {
		this.favorites.setValue(blueprint.instanceGuid, blueprint);
		blueprint.SetFavorite(true);
		signals.favoriteAdded.emit(blueprint);
		signals.favoritesChanged.emit();
	}

	public RemoveFavorite(blueprint: Blueprint) {
		blueprint.SetFavorite(false);
		this.favorites.remove(blueprint.instanceGuid);
		signals.favoriteRemoved.emit(blueprint);
		signals.favoritesChanged.emit();
	}

	public Focus(guid: Guid) {
		let target: GameObject | undefined;
		if (guid) {
			target = this.getGameObjectByGuid(guid);
		} else {
			target = this.selectionGroup;
			if (target.children.length === 0) {
				return;
			} // Nothing specified, nothing selected. skip.
		}
		if (target === undefined) {
			return;
		}
		this.threeManager.Focus(target);
		signals.objectFocused.emit(target);
	}

	public Duplicate() {
		const scope = this;
		const commands: Command[] = [];
		this.selectionGroup.children.forEach((childGameObject) => {
			const gameObjectTransferData = childGameObject.getGameObjectTransferData();
			gameObjectTransferData.guid = Guid.create();

			commands.push(new SpawnBlueprintCommand(gameObjectTransferData));
		});
		console.log(commands);
		scope.execute(new BulkCommand(commands));
	}

	public Copy() {
		const scope = this;
		const commands: SpawnBlueprintCommand[] = [];
		this.selectionGroup.children.forEach((childGameObject: GameObject) => {
			const gameObjectTransferData = childGameObject.getGameObjectTransferData();
			gameObjectTransferData.guid = Guid.create();

			commands.push(new SpawnBlueprintCommand(gameObjectTransferData));
		});
		scope.copy = commands;
	}

	public Paste() {
		const scope = this;
		if (scope.copy !== null) {
			// Generate a new guid for each command
			scope.copy.forEach((command: SpawnBlueprintCommand) => {
				command.gameObjectTransferData.guid = Guid.create();
			});
			scope.execute(new BulkCommand(scope.copy));
		}
	}

	public Cut() {
		this.Copy();
		this.DeleteSelected();
	}

	public SpawnBlueprint(blueprint: Blueprint, transform?: LinearTransform, variation?: number, parentData?: GameObjectParentData) {
		if (blueprint == null) {
			window.LogError('Tried to spawn a nonexistent blueprint');
			return false;
		}

		if (transform === undefined) {
			transform = this.editorCore.getRaycastTransform();
		}

		if (variation === undefined) {
			variation = blueprint.getDefaultVariation();
		}
		if (parentData === undefined) {
			parentData = new GameObjectParentData(Guid.createEmpty(), 'root', Guid.createEmpty(), Guid.createEmpty());
		}

		// Spawn blueprint
		window.Log(LOGLEVEL.VERBOSE, 'Spawning blueprint: ' + blueprint.instanceGuid);
		const gameObjectTransferData = new GameObjectTransferData({
			guid: Guid.create(),
			name: blueprint.name,
			parentData,
			blueprintCtrRef: blueprint.getCtrRef(),
			transform,
			variation,
			isDeleted: false,
			isEnabled: true
		});

		this.execute(new SpawnBlueprintCommand(gameObjectTransferData));
	}

	/*	DisableSelected() {
		let scope = this;
		let commands = [];
		editor.selectionGroup.children.forEach(function(childGameObject) {
			let gameObjectTransferData = new GameObjectTransferData({
				guid: childGameObject.guid
			});

			commands.push(new DisableBlueprintCommand(gameObjectTransferData));
		});
		if(commands.length > 0) {
			scope.execute(new BulkCommand(commands));
		}
	} */

	// TODO: EnableBlueprintCommand and DisableBlueprintCommand are not invoked anywhere, but the whole lua side works.

	public DeleteSelected() {
		const scope = this;
		const commands: Command[] = [];
		this.selectionGroup.children.forEach((childGameObject) => {
			if (childGameObject instanceof GameObject) {
				commands.push(new DestroyBlueprintCommand(childGameObject.getGameObjectTransferData()));
			}
		});

		if (commands.length > 0) {
			scope.execute(new BulkCommand(commands));
		}
	}

	public getGameObjectByGuid(guid: Guid) {
		return this.gameObjects.getValue(guid);
	}

	public SetRaycastPosition(x: number, y: number, z: number) {
		this.editorCore.raycastTransform.trans = new Vec3(x, y, z);
	}

	public SetScreenToWorldPosition(x: number, y: number, z: number) {
		this.editorCore.screenToWorldTransform.trans = new Vec3(x, y, z);
	}

	public setUpdating(value: boolean) {
		this.editorCore.setUpdating(value);
	}

	/*

		Commands

	*/
	public Select(guid: Guid) {
		this.editorCore.select(guid);
	}

	public Deselect(guid: Guid) {
		this.editorCore.onDeselectedGameObject(guid);
	}

	public onSetObjectName(commandActionResult: CommandActionResult) {
		const gameObjectTransferData = commandActionResult.gameObjectTransferData as GameObjectTransferData;
		const gameObject = this.editorCore.getGameObjectFromGameObjectTransferData(gameObjectTransferData, 'onSetObjectName');
		if (gameObject !== undefined) {
			(gameObject as GameObject).setName(gameObjectTransferData.name);
		}
	}

	public onSetTransform(commandActionResult: CommandActionResult) {
		const gameObjectTransferData = commandActionResult.gameObjectTransferData as GameObjectTransferData;
		const gameObject = this.editorCore.getGameObjectFromGameObjectTransferData(gameObjectTransferData, 'onSetTransform');
		if (gameObject !== undefined) {
			(gameObject as GameObject).setTransform(gameObjectTransferData.transform);
		}

		this.threeManager.Render();
	}

	public onSetVariation(commandActionResult: CommandActionResult) {
		const gameObjectTransferData = commandActionResult.gameObjectTransferData as GameObjectTransferData;
		const gameObject = this.editorCore.getGameObjectFromGameObjectTransferData(gameObjectTransferData, 'onSetVariation');
		if (gameObject !== undefined) {
			(gameObject as GameObject).setVariation(gameObjectTransferData.variation);
		}
	}

	public onDestroyedBlueprint(commandActionResult: CommandActionResult) {
		const gameObjectTransferData = commandActionResult.gameObjectTransferData as GameObjectTransferData;
		const gameObjectGuid = gameObjectTransferData.guid;
		const gameObject = this.gameObjects.getValue(gameObjectGuid);
		if (gameObject === undefined) {
			return;
		}
		this.threeManager.DeleteObject(gameObject);
		this.gameObjects.remove(gameObjectGuid);

		if (this.selectionGroup.children.length === 0) {
			this.threeManager.HideGizmo();
		}

		this.threeManager.Render();
	}

	// TODO: Move logic to GameContext
	public onSpawnedBlueprint(commandActionResult: CommandActionResult) {
		const scope = this;
		const gameObjectTransferData = commandActionResult.gameObjectTransferData as GameObjectTransferData;
		const gameObjectGuid = gameObjectTransferData.guid;
		const parentGuid = gameObjectTransferData.parentData.guid;

		const gameObject = GameObject.CreateWithTransferData(gameObjectTransferData);
		editor.threeManager.AttachToScene(gameObject);
		gameObject.updateTransform();
		for (const gameEntityData of gameObjectTransferData.gameEntities) {
			const entityData = gameEntityData;
			// UniqueID is fucking broken. this won't work online, boi.
			if (entityData.isSpatial) {
				const gameEntity = new SpatialGameEntity(entityData.instanceId, entityData.transform, entityData.aabb);
				gameObject.add(gameEntity);
			}
		}

		this.gameObjects.setValue(gameObjectGuid, gameObject);
		// If the parent is the leveldata, ignore all this
		// todo: make an entry for the leveldata itself maybe?

		// Allows children to be spawned before parents, and then added to the appropriate parent.
		if (!scope.gameContext.levelData.containsKey(parentGuid)) {
			if (!this.gameObjects.containsKey(parentGuid)) {
				let parent = this.missingParent.getValue(parentGuid);
				if (parent === undefined) {
					this.missingParent.setValue(parentGuid, []);
					parent = this.missingParent.getValue(parentGuid);
				}
				if (parent !== undefined) { // hack to suppress compiler warnings.
					parent.push(gameObject);
				}
			} else {
				if (!this.gameObjects.getValue(parentGuid) === undefined) {
					const parent = this.gameObjects.getValue(parentGuid) as GameObject;
					parent.attach(gameObject);
				}
			}

			if (this.missingParent.containsKey(gameObjectGuid)) {
				const missingParent = this.missingParent.getValue(gameObjectGuid);
				if (missingParent !== undefined) {
					missingParent.every((child) => {
						gameObject.attach(child);
					});
				}

				this.missingParent.remove(gameObjectGuid);
			}
		}
		if (!scope.vext.executing && commandActionResult.sender === this.getPlayerName()) {
			// Make selection happen after all signals have been handled
			setTimeout(() => {
				scope.Select(gameObjectGuid);
			}, 2);
		}
		// We only add the GameObject to the scene when we're accessing it.
	}

	public onBlueprintSpawnInvoked(commandActionResult: CommandActionResult) {
		console.log('Successfully invoke spawning of blueprint: ' + commandActionResult.gameObjectTransferData.name + ' | ' + commandActionResult.gameObjectTransferData.guid);
	}

	public onEnabledBlueprint(commandActionResult: CommandActionResult) {
		const gameObject = this.getGameObjectByGuid(commandActionResult.gameObjectTransferData.guid);

		if (gameObject == null) {
			window.LogError('Attempted to enable a GameObject that doesn\'t exist');
			return;
		}

		const removeFromHierarchy = commandActionResult.gameObjectTransferData.isDeleted;
		gameObject.Enable(); // removeFromHierarchy);
	}

	public onDisabledBlueprint(commandActionResult: CommandActionResult) {
		const gameObject = this.getGameObjectByGuid(commandActionResult.gameObjectTransferData.guid);

		if (gameObject == null) {
			window.LogError('Attempted to disable a GameObject that doesn\'t exist');
			return;
		}

		const isDeletedVanillaObject = commandActionResult.gameObjectTransferData.isDeleted;
		gameObject.Disable(); // isDeletedVanillaObject:);
	}

	public onObjectChanged(object: GameObject) {
		this.editorCore.addPending(object.guid, object);
	}

	/*

		History

	 */

	public execute(cmd: Command, optionalName?: string) {
		this.history.execute(cmd, optionalName);
	}

	public undo() {
		this.history.undo();
	}

	public redo() {
		this.history.redo();
	}
}
window.addEventListener('resize', () => {
	signals.windowResized.emit();
});
