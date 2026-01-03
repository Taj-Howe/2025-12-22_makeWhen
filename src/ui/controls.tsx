import {
  Button,
  Checkbox,
  IconButton,
  Select,
  Switch,
  TextArea,
  TextField,
  type ButtonProps,
  type CheckboxProps,
  type IconButtonProps,
  type SelectProps,
  type SwitchProps,
  type TextAreaProps,
} from "@radix-ui/themes";
import { forwardRef, type CSSProperties, type ComponentPropsWithoutRef } from "react";

type AppButtonProps = ButtonProps;
const AppButton = (props: AppButtonProps) => <Button {...props} />;

type AppIconButtonProps = IconButtonProps;
const AppIconButton = (props: AppIconButtonProps) => <IconButton {...props} />;

type AppInputProps = ComponentPropsWithoutRef<typeof TextField.Root> & {
  rootClassName?: string;
  rootStyle?: CSSProperties;
};
const AppInput = forwardRef<HTMLInputElement, AppInputProps>(
  ({ rootClassName, rootStyle, className, style, ...props }, ref) => (
    <TextField.Root
      ref={ref}
      className={[className, rootClassName].filter(Boolean).join(" ")}
      style={{ ...(style ?? {}), ...(rootStyle ?? {}) }}
      {...props}
    />
  )
);
AppInput.displayName = "AppInput";

type AppTextAreaProps = TextAreaProps;
const AppTextArea = (props: AppTextAreaProps) => <TextArea {...props} />;

type AppSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};
type AppSelectProps = Omit<SelectProps, "value" | "onValueChange"> & {
  value?: string;
  onChange?: (value: string) => void;
  options: AppSelectOption[];
  placeholder?: string;
};
const AppSelect = ({
  value,
  onChange,
  options,
  placeholder,
  ...props
}: AppSelectProps) => (
  <Select.Root value={value} onValueChange={onChange} {...props}>
    <Select.Trigger placeholder={placeholder} />
    <Select.Content>
      {options.map((option) => (
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
