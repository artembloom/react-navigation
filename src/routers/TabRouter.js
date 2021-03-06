/* @flow */

import React from 'react';

import getScreenForRouteName from './getScreenForRouteName';
import createConfigGetter from './createConfigGetter';
import invariant from 'fbjs/lib/invariant';
import warning from 'fbjs/lib/warning';

import NavigationActions from '../NavigationActions';
import StateUtils from '../StateUtils';

import validateRouteConfigMap from './validateRouteConfigMap';

import type {
  NavigationAction,
  NavigationComponent,
  NavigationState,
  NavigationRouteConfigMap,
  NavigationParams,
  NavigationRouter,
  NavigationNavigateAction,
  NavigationTabRouterConfig,
} from '../TypeDefinition';

export default (
  routeConfigs: NavigationRouteConfigMap,
  config: NavigationTabRouterConfig = {}
): NavigationRouter => {
  // Fail fast on invalid route definitions
  validateRouteConfigMap(routeConfigs);

  const order = config.order || Object.keys(routeConfigs);
  const paths = config.paths || {};
  const initialRouteName = config.initialRouteName || order[0];
  const initialRouteIndex = order.indexOf(initialRouteName);
  const backBehavior = config.backBehavior || 'initialRoute';
  const shouldBackNavigateToInitialRoute = backBehavior === 'initialRoute';
  const tabRouters = {};
  order.forEach((routeName: string) => {
    const routeConfig = routeConfigs[routeName];
    paths[routeName] = typeof routeConfig.path === 'string' ? routeConfig.path : routeName;
    tabRouters[routeName] = null;
    if (routeConfig.screen && routeConfig.screen.router) {
      tabRouters[routeName] = routeConfig.screen.router;
    }
  });
  invariant(
    initialRouteIndex !== -1,
    `Invalid initialRouteName '${initialRouteName}' for TabRouter. ` +
    `Should be one of ${order.map((n: *) => `"${n}"`).join(', ')}`
  );
  return {
    getStateForAction(action: NavigationAction, inputState: ?NavigationState): ?NavigationState {
      action = NavigationActions.mapDeprecatedActionAndWarn(action)

      // Establish a default state
      let state = inputState;
      if (!state) {
        const routes = order.map((routeName: string) => {
          const tabRouter = tabRouters[routeName];
          if (tabRouter) {
            return {
              ...tabRouter.getStateForAction(action.action || NavigationActions.init()),
              key: routeName,
              routeName,
            };
          }
          return {
            key: routeName,
            routeName,
          };
        });
        state = {
          routes,
          index: initialRouteIndex,
        };
        // console.log(`${order.join('-')}: Initial state`, {state});
      }

      // Let the current tab handle it
      const activeTabLastState = state.routes[state.index];
      const activeTabRouter = tabRouters[order[state.index]];
      if (activeTabRouter) {
        const activeTabState = activeTabRouter.getStateForAction(action.action || action, activeTabLastState);
        if (!activeTabState && inputState) {
          return null;
        }
        if (activeTabState && activeTabState !== activeTabLastState) {
          const routes = [...state.routes];
          routes[state.index] = activeTabState;
          return {
            ...state,
            routes,
          };
        }
      }

      // Handle tab changing. Do this after letting the current tab try to
      // handle the action, to allow inner tabs to change first
      let activeTabIndex = state.index;
      const isBackEligible = action.key == null || action.key === activeTabLastState.key;
      if (action.type === NavigationActions.BACK && isBackEligible && shouldBackNavigateToInitialRoute) {
        activeTabIndex = initialRouteIndex;
      }
      let didNavigate = false;
      if (action.type === NavigationActions.NAVIGATE) {
        const navigateAction = ((action: any): NavigationNavigateAction);
        didNavigate = !!order.find((tabId: string, i: number) => {
          if (tabId === navigateAction.routeName) {
            activeTabIndex = i;
            return true;
          }
          return false;
        });
        if (didNavigate && action.action) {
          const tabRouter = tabRouters[action.routeName];
          const newChildState = tabRouter && tabRouter.getStateForAction(action.action, state.routes[activeTabIndex]);
          if (newChildState && newChildState !== state.routes[activeTabIndex]) {
            const routes = [...state.routes];
            routes[activeTabIndex] = newChildState;
            return {
              ...state,
              routes,
              index: activeTabIndex,
            };
          }
        }
        // console.log({navId: order.join('-'), action, order, lastIndex: state.index, index: activeTabIndex});
      }
      if (activeTabIndex !== state.index) {
        // console.log(`${order.join('-')}: Normal navigation`, {lastIndex: state.index, newIndex: activeTabIndex});
        return {
          ...state,
          index: activeTabIndex,
        };
      } else if (didNavigate && !inputState) {
        return state;
      } else if (didNavigate) {
        return null;
      }

      // Let other tabs handle it and switch to the first tab that returns a new state
      let index = state.index;
      let routes = state.routes;
      order.find((tabId: string, i: number) => {
        const tabRouter = tabRouters[tabId];
        if (i === index) {
          return false;
        }
        let tabState = routes[i];
        if (tabRouter) {
          // console.log(`${order.join('-')}: Processing child router:`, {action, tabState});
          tabState = tabRouter.getStateForAction(action, tabState);
        }
        if (!tabState) {
          index = i;
          return true;
        }
        if (tabState !== routes[i]) {
          routes = [...routes];
          routes[i] = tabState;
          index = i;
          return true;
        }
        return false;
      });
      // console.log(`${order.join('-')}: Processed other tabs:`, {lastIndex: state.index, index});

      if (index !== state.index || routes !== state.routes) {
        return {
          ...state,
          index,
          routes,
        };
      }
      return state;
    },

    getComponentForState(state: NavigationState) {
      const routeName = order[state.index];
      invariant(
        routeName,
        `There is no route defined for index ${state.index}. Check that
        that you passed in a navigation state with a valid tab/screen index.`
      );
      const childRouter = tabRouters[routeName];
      if (childRouter) {
        return childRouter.getComponentForState(state.routes[state.index]);
      }
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getComponentForRouteName(routeName: string): NavigationComponent {
      return getScreenForRouteName(routeConfigs, routeName);
    },

    getPathAndParamsForState(state: NavigationState) {
      const route = state.routes[state.index];
      const routeName = order[state.index];
      const subPath = paths[routeName];
      const screen = getScreenForRouteName(routeConfigs, routeName);
      let path = subPath;
      let params = route.params;
      if (screen && screen.router) {
        // If it has a router it's a navigator.
        // If it doesn't have router it's an ordinary React component.
        const child = screen.router.getPathAndParamsForState(route);
        path = subPath ? `${subPath}/${child.path}` : child.path;
        params = child.params ? { ...params, ...child.params } : params;
      }
      return {
        path,
        params,
      };
    },

    /**
     * Gets an optional action, based on a relative path and query params.
     *
     * This will return null if there is no action matched
     */
    getActionForPathAndParams(path: string, params: ?NavigationParams) {
      return order.map((tabId: string, index: number) => {
        const parts = path.split('/');
        const pathToTest = paths[tabId];
        if (parts[0] === pathToTest) {
          const tabRouter = tabRouters[tabId];
          const action: NavigationNavigateAction = NavigationActions.navigate({
            routeName: tabId,
          });
          if (tabRouter && tabRouter.getActionForPathAndParams) {
            action.action = tabRouter.getActionForPathAndParams(parts.slice(1).join('/'), params);
          } else if (params) {
            action.params = params;
          }
          return action;
        }
      }).find(action => !!action) || order.map((tabId: string, index: number) => {
        const tabRouter = tabRouters[tabId];
        return tabRouter && tabRouter.getActionForPathAndParams(path, params);
      }).find(action => !!action) || null;
    },

    getScreenConfig: createConfigGetter(routeConfigs, config.navigationOptions),
  };
};
