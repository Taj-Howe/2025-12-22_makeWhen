import {
  Button,
  Checkbox,
  IconButton,
  Select,
  Switch,
  TextArea,
  type ButtonProps,
  type CheckboxProps,
  type IconButtonProps,
  type SwitchProps,
  type TextAreaProps,
} from "@radix-ui/themes";
import * as RadixThemes from "@radix-ui/themes";
import { forwardRef, type CSSProperties, type ComponentPropsWithoutRef } from "react";

const mergeClassNames = (...values: Array<string | undefined>) =>
  values.filter(Boolean).join(" ");

type AppButtonProps = ButtonProps;
const AppButton = ({ className, ...props }: AppButtonProps) => (
  <Button
    className={mergeClassNames("app-control", "app-button", className)}
    {...props}
  />
);

type AppIconButtonProps = IconButtonProps;
const AppIconButton = ({ className, ...props }: AppIconButtonProps) => (
  <IconButton
    className={mergeClassNames("app-control", "app-icon-button", className)}
    {...props}
  />
);

type AppInputProps = ComponentPropsWithoutRef<typeof RadixThemes.TextField.Root> & {
  rootClassName?: string;
  rootStyle?: CSSProperties;
};
const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  ({ rootClassName, rootStyle, className, style, ...props }, ref) => (
    <RadixThemes.TextField.Root
      ref={ref}
      className={mergeClassNames(
        "app-control",
        "app-input-control",
        className,
        rootClassName
      )}
      style={{ ...(style ?? {}), ...(rootStyle ?? {}) }}
      {...props}
    />
  )
);
AppInput.displayName = "AppInput";

type AppTextAreaProps = TextAreaProps;
const AppTextArea = ({ className, ...props }: AppTextAreaProps) => (
  <TextArea
    className={mergeClassNames("app-control", "app-textarea-control", className)}
    {...props}
  />
);

type AppSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};
type AppSelectProps = Omit<
  ComponentPropsWithoutRef<typeof Select.Root>,
  "value" | "onValueChange"
> & {
  value?: string;
  onChange?: (value: string) => void;
  options: AppSelectOption[];
  placeholder?: string;
};
const EMPTY_SELECT_VALUE = "__empty__";

const AppSelect = ({
  value,
  onChange,
  options,
  placeholder,
  ...props
}: AppSelectProps) => {
  const safeValue =
    value === undefined ? undefined : value === "" ? EMPTY_SELECT_VALUE : value;
  const safeOptions = options.map((option) => ({
    ...option,
    value: option.value === "" ? EMPTY_SELECT_VALUE : option.value,
  }));
  const handleChange = (nextValue: string) => {
    if (!onChange) return;
    onChange(nextValue === EMPTY_SELECT_VALUE ? "" : nextValue);
  };

  return (
    <Select.Root value={safeValue} onValueChange={handleChange} {...props}>
      <Select.Trigger
        className="app-control app-select-trigger"
        placeholder={placeholder}
      />
      <Select.Content>
        {safeOptions.map((option) => (
          <Select.Item
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
};

type AppSwitchProps = SwitchProps;
const AppSwitch = (props: AppSwitchProps) => <Switch {...props} />;

type AppCheckboxProps = CheckboxProps;
const AppCheckbox = (props: AppCheckboxProps) => <Checkbox {...props} />;

export {
  AppButton,
  AppCheckbox,
  AppIconButton,
  AppInput,
  AppSelect,
  AppSwitch,
  AppTextArea,
};
